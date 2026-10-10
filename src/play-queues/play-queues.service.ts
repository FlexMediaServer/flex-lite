import { Injectable, NotFoundException } from '@nestjs/common';
import { Metadata } from '../dto/Metadata.entity.js';
import { MetadataService } from '../metadata/metadata.service.js';
import { db } from '../utils/database.js';

export const PLAY_QUEUE_WINDOW_SIZE = 21;

export type PlayQueue = {
	id?: number;
	playbackSessionId: string;
	item: string; //Show or movie Plex GUID (plex://show/<id> | plex://movie/<id>)
	currentItem: string; //GUID of the currently playing item
	offset: number; //Internal, client-invisible offset into the full episode list
};

type PlayQueueWindow = {
	items: Metadata[];
	totalSize: number;
};

export function parsePlexGuid(guid: string): { type: string; ratingKey: string } | undefined {
	const match = /^plex:\/\/(show|season|episode|movie)\/(.+)$/.exec(guid ?? '');
	if (!match) return;

	return { type: match[1], ratingKey: match[2] };
}

function toPlayQueue(item: { id: number; currentItem: string; playbackSessionId: string; item: string; offset: number }): PlayQueue {
	return {
		id: item.id,
		currentItem: item.currentItem,
		playbackSessionId: item.playbackSessionId,
		item: item.item,
		offset: item.offset,
	};
}

@Injectable()
export class PlayQueuesService {
	constructor(private metadataService: MetadataService) {}

	async getPlayQueue(playQueueId: number): Promise<PlayQueue | undefined> {
		const item = await db.selectFrom('play_queues').selectAll().where('id', '=', playQueueId).executeTakeFirst();
		if (!item) return;

		return toPlayQueue(item);
	}

	async getPlayQueueByPlaybackSession(playbackSessionId: string): Promise<PlayQueue | undefined> {
		const item = await db.selectFrom('play_queues').selectAll().where('playbackSessionId', '=', playbackSessionId).executeTakeFirst();
		if (!item) return;

		return toPlayQueue(item);
	}

	async setPlayQueue(playQueueId: number, value: PlayQueue): Promise<PlayQueue> {
		const item = await db
			.insertInto('play_queues')
			.values({
				id: playQueueId,
				playbackSessionId: value.playbackSessionId,
				item: value.item,
				currentItem: value.currentItem,
				offset: value.offset,
			})
			.onConflict((oc) =>
				oc.column('id').doUpdateSet({
					playbackSessionId: value.playbackSessionId,
					item: value.item,
					currentItem: value.currentItem,
					offset: value.offset,
					updated_at: Math.floor(Date.now() / 1000),
				}),
			)
			.returningAll()
			.executeTakeFirst();

		return {
			id: item?.id,
			currentItem: item?.currentItem as string,
			playbackSessionId: item?.playbackSessionId as string,
			item: item?.item as string,
			offset: item?.offset as number,
		};
	}

	/*
	 * Fetches the current window of items from Plex Discover. Items are never stored;
	 * only the show/movie GUID, the current item GUID and the internal offset are persisted.
	 */
	async fetchWindow(playQueue: PlayQueue): Promise<PlayQueueWindow> {
		const parsed = parsePlexGuid(playQueue.item);
		if (!parsed) return { items: [], totalSize: 0 };

		if (parsed.type === 'movie') {
			const movie = await this.metadataService.getItem(parsed.ratingKey);
			return { items: movie ? [movie] : [], totalSize: movie ? 1 : 0 };
		}

		const result = await this.metadataService.getItemGrandchildren(parsed.ratingKey, PLAY_QUEUE_WINDOW_SIZE, playQueue.offset);

		return {
			items: result?.metadata ?? [],
			totalSize: result?.totalSize ?? 0,
		};
	}

	/*
	 * Computes the internal offset for an arbitrary episode by summing the leafCount of
	 * all preceding seasons (sorted by index so specials count naturally) plus the
	 * episode's position within its own season.
	 */
	async computeOffset(ratingKey: string): Promise<{ currentItem: string; item: string; offset: number }> {
		const episode = await this.metadataService.getItem(ratingKey);
		if (!episode) throw new NotFoundException('Could not find item to select in play queue');

		if (episode.type === 'movie') {
			return {
				currentItem: episode.guid ?? `plex://movie/${episode.ratingKey}`,
				item: `plex://movie/${episode.ratingKey}`,
				offset: 0,
			};
		}

		const showRatingKey = episode.grandparentRatingKey;
		if (!showRatingKey) throw new NotFoundException('Could not determine show for play queue item');

		const seasons = ((await this.metadataService.getItemChildren(showRatingKey)) ?? []).sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
		const parentIndex = episode.parentIndex ?? 0;

		let offset = 0;
		for (const season of seasons) {
			if ((season.index ?? 0) >= parentIndex) break;
			offset += season.leafCount ?? 0;
		}

		if (episode.parentRatingKey) {
			const seasonEpisodes = (await this.metadataService.getItemChildren(episode.parentRatingKey)) ?? [];
			const position = seasonEpisodes.findIndex((item) => item.ratingKey === episode.ratingKey);
			offset += position >= 0 ? position : Math.max((episode.index ?? 1) - 1, 0);
		}

		return {
			currentItem: episode.guid ?? `plex://episode/${episode.ratingKey}`,
			item: `plex://show/${showRatingKey}`,
			offset,
		};
	}

	/* Selects an episode/movie by ratingKey, recomputing the internal offset. */
	async selectItem(playQueueId: number, itemId: string) {
		const playQueue = await this.getPlayQueue(playQueueId);
		if (!playQueue) return;

		const computed = await this.computeOffset(itemId);
		await this.setPlayQueue(playQueueId, {
			...playQueue,
			item: computed.item,
			currentItem: computed.currentItem,
			offset: computed.offset,
		});
	}

	/* Selects the item at the given index within the currently fetched window. */
	async selectIndex(playQueueId: number, index: number) {
		const playQueue = await this.getPlayQueue(playQueueId);
		if (!playQueue) return;

		const { items } = await this.fetchWindow(playQueue);
		const targetItem = items[index];
		if (!targetItem) return;

		await this.setPlayQueue(playQueueId, {
			...playQueue,
			currentItem: targetItem.guid ?? targetItem.ratingKey,
			offset: playQueue.offset + index,
		});
	}

	/* The episode after the current one, from the given window or the next page when the current item is its last. */
	async findNext(playQueue: PlayQueue, items: Metadata[]): Promise<{ item?: Metadata; offset: number }> {
		const currentRatingKey = playQueue.currentItem.split('/').pop();
		const currentIndex = items.findIndex((item) => item.guid === playQueue.currentItem || item.ratingKey === currentRatingKey);

		if (currentIndex !== -1 && currentIndex + 1 < items.length) {
			// Next item is still within the fetched window
			return { item: items[currentIndex + 1], offset: playQueue.offset + currentIndex + 1 };
		}

		// Window is exhausted, paginate to the next page of episodes
		const offset = currentIndex === -1 ? playQueue.offset + 1 : playQueue.offset + items.length;
		const next = await this.fetchWindow({ ...playQueue, offset });
		return { item: next.items[0], offset };
	}

	/* Advances the queue to the next episode, paginating the window when exhausted. */
	async continueId(playQueueId: number, itemId?: string): Promise<string | null> {
		const playQueue = await this.getPlayQueue(playQueueId);
		if (!playQueue) return null;

		if (itemId) {
			await this.selectItem(playQueueId, itemId);
			return itemId;
		}

		const { items } = await this.fetchWindow(playQueue);
		const next = await this.findNext(playQueue, items);

		if (!next.item) return null;

		await this.setPlayQueue(playQueueId, {
			...playQueue,
			currentItem: next.item.guid ?? next.item.ratingKey,
			offset: next.offset,
		});

		return next.item.ratingKey;
	}

	async continueSessionId(playbackSessionId: string, itemId?: string) {
		const playQueue = await this.getPlayQueueByPlaybackSession(playbackSessionId);
		if (!playQueue) return;
		await this.continueId(playQueue.id!, itemId);
	}
}
