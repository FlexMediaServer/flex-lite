import { Injectable } from '@nestjs/common';
import { Metadata } from '../dto/Metadata.entity.js';
import { db } from '../utils/database.js';

export type PlayQueue = {
	id?: number;
	playbackSessionId: string;
	currentItem: string;
	items: Metadata[];
};

function isMetadataItem(value: unknown): value is Metadata {
	return typeof value === 'object' && value !== null && 'ratingKey' in value && typeof value.ratingKey === 'string';
}

function isMetadataArray(value: unknown): value is Metadata[] {
	return Array.isArray(value) && value.every((item) => isMetadataItem(item));
}

function parsePlayQueueItems(items: string | JSON): Metadata[] {
	if (typeof items === 'string') {
		const parsedItems: unknown = JSON.parse(items);
		return isMetadataArray(parsedItems) ? parsedItems : [];
	}

	return isMetadataArray(items) ? items : [];
}

function toPlayQueue(item: { id: number; currentItem: string; playbackSessionId: string; items: string | JSON }): PlayQueue {
	return {
		id: item.id,
		currentItem: item.currentItem,
		playbackSessionId: item.playbackSessionId,
		items: parsePlayQueueItems(item.items),
	};
}

@Injectable()
export class PlayQueuesService {
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
				...value,
				id: playQueueId,
				items: JSON.stringify(value.items),
			})
			.onConflict((oc) =>
				oc.column('id').doUpdateSet({
					currentItem: value.currentItem,
					items: JSON.stringify(value.items),
					updated_at: Math.floor(Date.now() / 1000),
				}),
			)
			.returningAll()
			.executeTakeFirst();

		return {
			id: item?.id,
			currentItem: item?.currentItem as string,
			playbackSessionId: item?.playbackSessionId as string,
			items: value.items,
		};
	}

	async selectIndex(playQueueId: number, index: number) {
		const playQueue = await this.getPlayQueue(playQueueId);
		if (!playQueue) return;
		playQueue.currentItem = playQueue.items[index].ratingKey;
		await this.setPlayQueue(playQueue.id!, playQueue);
	}

	async selectItem(playQueueId: number, itemId: string) {
		const playQueue = await this.getPlayQueue(playQueueId);
		if (!playQueue) return;
		const targetItem = playQueue.items.find((item) => item.ratingKey == itemId);
		if (!targetItem) return;
		playQueue.currentItem = targetItem.ratingKey;
		await this.setPlayQueue(playQueue.id!, playQueue);
	}

	async continueId(playQueueId: number, itemId?: string) {
		const playQueue = await this.getPlayQueue(playQueueId);
		if (!playQueue) return null;

		if (itemId) playQueue.currentItem = itemId;
		else {
			const currentIndex = playQueue.items.findIndex((item) => item.ratingKey == playQueue.currentItem);
			playQueue.currentItem = playQueue.items[currentIndex + 1].ratingKey;
		}
	}

	async continueSessionId(playbackSessionId: string, itemId?: string) {
		const playQueue = await this.getPlayQueueByPlaybackSession(playbackSessionId);
		if (!playQueue) return;
		await this.continueId(playQueue.id!, itemId);
	}
}
