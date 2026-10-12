import { Post, Query, Headers, Res, NotFoundException, Controller, Get, Param, InternalServerErrorException, Put, Delete, Req, StreamableFile, Header, UseGuards } from '@nestjs/common';
import { randomInt, randomUUID } from 'node:crypto';
import { PlayQueuesQuery } from './play-queues.dto.js';
import { parseKey } from '../utils/generic.js';
import { MetadataService } from '../metadata/metadata.service.js';
import { StremioService } from '../stremio/stremio.service.js';
import { PMSService } from '../plex/plex.service.js';
import { ScrobblingService } from '../scrobbling/scrobbling.service.js';
import { PlayQueue, PlayQueuesService } from './play-queues.service.js';
import { Metadata } from '../dto/Metadata.entity.js';
import { emptyMedia, serializePlayQueues } from '../utils/plex.js';
import { Readable } from 'node:stream';
import { MediaContainer } from '../dto/MediaContainer.entity.js';
import { IsXML } from '../is-xml.decorator.js';
import { User } from '../utils/user.decorator.js';
import { AppService } from '../app.service.js';
import util from 'util';
import { LoggedInGuard } from '../middleware/logged-in.guard.js';
import { rememberPlaybackUser } from '../status/playback-sessions.js';

//Clients send the playback session id under different names, either as a header or as a query param
const SESSION_ID_NAMES = ['x-plex-playback-session-id', 'x-plex-session-identifier', 'x-plex-session-id'];

export function playbackSessionIdOf(headers: Record<string, any>, query: Record<string, any> = {}): string | undefined {
	for (const name of SESSION_ID_NAMES) {
		const value = headers[name] ?? Object.entries(query).find(([key]) => key.toLowerCase() === name)?.[1];
		if (value) return String(value);
	}

	return undefined;
}

@Controller()
@UseGuards(LoggedInGuard)
export class PlayQueuesController {
	constructor(
		private appService: AppService,
		private metadataService: MetadataService,
		private stremioService: StremioService,
		private pmsService: PMSService,
		private scrobblingService: ScrobblingService,
		// private playbackService: PlaybackService,
		private playQueuesService: PlayQueuesService,
	) {}

	@Post(['/playQueues'])
	async playQueues(
		@Query() query: any,
		@Headers() headers: any,
		@Res({ passthrough: true }) res: Response,
		// @IsXML() isXML,
	) {
		const parsedPath = parseKey(query.key ? query.key : decodeURIComponent(new URL(query.uri).pathname));
		const item = await this.metadataService.getItem(parsedPath.itemId) as Metadata;

		//Some clients send no session id at all. The queue still needs one, so a generated id stands in for it.
		const playbackSessionId = playbackSessionIdOf(headers, query) ?? randomUUID();

		// Only the show/movie GUID, current item GUID and internal offset are stored.
		// Episode lists are fetched live from the Plex Discover /grandchildren endpoint.
		let show: string | undefined;
		let currentItem: string | undefined;
		let offset = 0;

		if (item.type == 'show' || item.type == 'movie') {
			show = item.guid ?? `plex://${item.type}/${item.ratingKey}`;
			offset = 0;

			const window = await this.playQueuesService.fetchWindow({ playbackSessionId, item: show, currentItem: '', offset });
			currentItem = window.items[0]?.guid;
		} else if (item.type == 'season') {
			// Start at episode 1 of the season: offset = total episodes of all previous seasons
			show = `plex://show/${item.parentRatingKey}`;

			const seasons = ((await this.metadataService.getItemChildren(item.parentRatingKey)) ?? []).sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
			for (const season of seasons) {
				if ((season.index ?? 0) >= (item.index ?? 0)) break;
				offset += season.leafCount ?? 0;
			}

			const window = await this.playQueuesService.fetchWindow({ playbackSessionId, item: show, currentItem: '', offset });
			currentItem = window.items[0]?.guid;
		} else if (item.type == 'episode') {
			// Offset = total episodes of all previous seasons + the episode's position in its season
			const computed = await this.playQueuesService.computeOffset(item.ratingKey);
			show = computed.item;
			currentItem = computed.currentItem;
			offset = computed.offset;
		}

		if (!currentItem) {
			throw new NotFoundException('Could not determine current item for play queue');
		}

		const playQueue = await this.playQueuesService.setPlayQueue(randomInt(0, 1_000_000), {
			playbackSessionId,
			item: show as string,
			currentItem,
			offset,
		});

		console.debug(`Play queue created... ${playQueue.id}`);

		const window = await this.playQueuesService.fetchWindow(playQueue);
		const currentRatingKey = currentItem.split('/').pop();
		const currentItemObj = window.items.find((entry: any) => entry.guid === currentItem || entry.ratingKey === currentRatingKey) as Metadata;

		const localItem = await this.appService.resolveMedia(currentItemObj);
		if (!localItem) throw new NotFoundException();

		this.prefetchNext(playQueue, window.items);

		for (const windowItem of window.items) {
			if (windowItem === currentItemObj) {
				windowItem.Media = localItem.Media?.[0] ? [localItem.Media[0]] : (emptyMedia() as any);
			} else {
				windowItem.Media = emptyMedia() as any;
			}
		}

		return serializePlayQueues(playQueue, window, false);
	}

	//Resolves the episode after the current one in the background, so it is ready when the client transitions to it.
	//Failures are only logged: the prefetch is an optimisation and must not affect the current item.
	private prefetchNext(playQueue: PlayQueue, items: Metadata[]) {
		this.playQueuesService
			.findNext(playQueue, items)
			.then(({ item }) => (item ? this.appService.resolveMedia(item) : undefined))
			.catch((error) => console.error(`Prefetch of next play queue item failed: ${error?.message ?? error}`));
	}

	@Get(['/playQueues/:id'])
	async getPlayQueues(@Param('id') playQueueId: any, @Query('center') center: any) {
		let playQueue = await this.playQueuesService.getPlayQueue(playQueueId);
		if (!playQueue) return new NotFoundException();

		//Required for some older clients, this is mainly done using /playQueues/:id?center=<play queue item id>
		if (center !== undefined) await this.playQueuesService.selectItem(playQueue.id as number, center);

		//Fetch play queue again for updated offset information
		playQueue = await this.playQueuesService.getPlayQueue(playQueueId);
		if (!playQueue) return new NotFoundException();

		const window = await this.playQueuesService.fetchWindow(playQueue);
		const currentRatingKey = playQueue.currentItem.split('/').pop();
		const currentItem = window.items.find((entry: any) => entry.guid === playQueue.currentItem || entry.ratingKey === currentRatingKey) as Metadata;
		if (!currentItem) throw new NotFoundException();

		const localItem = await this.appService.resolveMedia(currentItem);
		if (!localItem) throw new NotFoundException();

		for (const windowItem of window.items) {
			windowItem.Media = emptyMedia() as any;
		}

		if (localItem?.Media?.[0]) {
			currentItem.Media = [localItem.Media[0]];
		}

		return serializePlayQueues(playQueue, window, false);
	}

	@Get('/:id/timeline')
	async timeline(
		@Query()
		query: {
			key: string;
			ratingKey: string;
			time: string;
			duration: string;
			playQueueItemID: string;
			continuing: string;
		} & any,
		@Headers() headers: { 'x-plex-playback-session-id': string } & any,
		@User() user: MyPlexUser,
	) {
		const playbackSessionId = playbackSessionIdOf(headers, query);
		rememberPlaybackUser(playbackSessionId, user);

		const playQueue = playbackSessionId ? await this.playQueuesService.getPlayQueueByPlaybackSession(playbackSessionId) : undefined;

		const parsedPath = parseKey(query.key);
		const item = await this.metadataService.getItem(parsedPath.itemId);
		if (!item) throw new NotFoundException()

		if (playQueue) {
			const currentRatingKey = playQueue.currentItem.split('/').pop();
			if (currentRatingKey !== query.playQueueItemID) {
				// //Required for some older clients, this is mainly done using /playQueues/:id?center=<play queue item id>
				await this.playQueuesService.selectItem(playQueue.id as number, query.playQueueItemID);
			}
		}

		//The shared not found copy is not this item, so its playback is not reported to Plex
		if (await this.pmsService.isNotFoundItem(item)) return;

		let localItem = (await this.pmsService.resolveLocalItem([item]))[0];
		if (!localItem) return new NotFoundException()

		query.path = localItem.key
		query.key = localItem.key
		// query.guid = item.guid
		query.ratingKey = localItem.key.split('/').pop()

		if (query['X-Plex-Device'] === '') delete query['X-Plex-Device']

		delete query['X-Plex-Token']
		delete headers['x-plex-token']

		const res = await this.pmsService.plexServerApi('/:/timeline', {
			query,
			headers
		});

		const viewOffset = parseInt(query.time);
		if (!isNaN(viewOffset) && ['playing', 'paused'].includes(query.state)) {
			await this.scrobblingService.timeline(item, user, viewOffset, playbackSessionId);
		}

		return res;
	}

	@Post('/:id/timeline')
	timelinePost(@Query() query: any, @Headers() headers: any, @User() user: any) {
		return this.timeline(query, headers, user)
	}

	@Get(['/:id/scrobble', '/:id/unscrobble'])
	async scrobble(
		@Req() req: any,
		@User() user: MyPlexUser,
		@Query()
		query: {
			key: string;
			ratingKey: string;
			time: string;
			duration: string;
			playQueueItemID: string;
			continuing: string;
		} & any,
		@Headers() headers: { 'x-plex-playback-session-id': string } & any,
	) {

		const scrobble = req.path.endsWith('/scrobble');

		const item = await this.metadataService.getItem(query.key);
		if (!item) throw new NotFoundException();

		if (scrobble) void this.scrobblingService.scrobble(item, user, playbackSessionIdOf(headers, query));
		else void this.scrobblingService.unscrobble(item, user);
	}

	@Put(['/:id/scrobble', '/:id/unscrobble'])
	async scrobblePut(@Req() req: any, @Query() query: any, @User() user: MyPlexUser, @Headers() headers: { 'x-plex-playback-session-id': string } & any) {
		return await this.scrobble(req, user, query, headers);
	}


	@Get('/video/:id/transcode/universal/decision')
	async decision (@Req() req: any, @Query() query: any, @Headers() headers: any, @IsXML() isXML: boolean) {
		const itemId = query.path.split('/').pop()
		let item = await this.metadataService.getItem(itemId)
		if (!item) throw new NotFoundException()

		const localItem = await this.appService.resolveMedia(item);
		if (!localItem) throw new NotFoundException()

		query.path = localItem.key
		if (query.videoResolution === '') query.videoResolution = '1080x1080'
		if (query['X-Plex-Device'] === '') delete query['X-Plex-Device']

		delete query['X-Plex-Token'];
		delete headers['x-plex-token'];
		delete headers['X-Plex-Token'];

		//Decision must be called on the underlying server for audio and subtitle tracks to update for the transcoder
		const decision = await this.pmsService.plexServerApi(req.path, {
			method: 'GET',
			query,
			headers
		});

		const Media = localItem.Media?.[0] ? {...localItem.Media[0]} : (emptyMedia() as any);

		if (decision.MediaContainer) {
			decision.MediaContainer.Metadata = undefined;
			delete decision.MediaContainer.size
		}

		return {
			MediaContainer: new MediaContainer({
				...decision.MediaContainer,
				resourceSession: query.session,

				[isXML ? 'Video' : 'Metadata']: [
					new Metadata({
						...item,

						Media: [Media],
					}),
				],
			})
		}
	}

	@Get([
		'/video/:id/transcode/universal/start.mpd',
		'/video/:id/transcode/universal/start.m3u8',
		'/video/:id/transcode/universal/start.mkv',
		'/video/:id/transcode/universal/start',
	])
	async start(@Req() req: any, @Res() res: any, @Query() query: any, @Headers() headers: any) {

		delete query['X-Plex-Token'];
		delete headers['x-plex-token'];
		delete headers['X-Plex-Token'];
		if (query['X-Plex-Device'] === '') delete query['X-Plex-Device']

		//This req can be called by some clients (eg. Tizen devices) without a path query param and just an existing session ID.
		if (query.path) {
			const itemId = query.path.split('/').pop()
			let item = await this.metadataService.getItem(itemId)
			if (!item) throw new NotFoundException('Plex metadata item not found')

			let localItem = (await this.pmsService.resolveLocalItem([item]))[0];
			if (!localItem) throw new NotFoundException('Local item not found')

			query.path = localItem.key
			if (query.videoResolution === '') query.videoResolution = '1080x1080'
	}

		if (req.path.includes('.mpd') || req.path.includes('.m3u8')) {
			const arrayBuffer = await this.pmsService.plexServerApi(req.baseUrl + req.path, {
				query,
				headers,
				responseType: 'arrayBuffer'
			});

			const buffer = Buffer.from(arrayBuffer);

			return res.status(200).send(buffer);
		}

		// console.log(req.baseUrl + req.path, localItem?.key)
		const response = await this.pmsService.plexServerApi.raw(req.baseUrl + req.path, {
			query,
			headers,
			responseType: 'stream',
		});

		res.status(response.status);

		const contentType = response.headers.get('content-type');
		if (contentType) res.header('Content-Type', contentType);

		const contentLength = response.headers.get('content-length');
		if (contentLength) res.header('Content-Length', contentLength);

		// Stream through with backpressure
		const nodeStream = Readable.fromWeb(response._data as any);
		req.on('close', () => nodeStream.destroy());
		nodeStream.pipe(res);
	}

	@Get('/library/parts/{*path}')
	async getPart (@Req() req: any, @Res({ passthrough: true }) res: any, @Query() query: any, @Headers() headers: any) {
		if (query['X-Plex-Device'] === '') delete query['X-Plex-Device']

		delete query['X-Plex-Token'];
		delete headers['x-plex-token'];
		delete headers['X-Plex-Token'];

		let response = await this.pmsService.plexServerApi.raw(req.path, {
			query,
			headers,
			method: 'GET',
			responseType: 'stream'
		})

		res.status(response.status);

		if (response.headers.get('content-range')) {
			res.header('Content-Range', response.headers.get('content-range'));
		}

		res.header('Accept-Ranges', 'bytes')

		//Extract headers from the response object
		const contentType = response.headers.get('content-type') || 'application/octet-stream';
		const contentDisposition = response.headers.get('content-disposition') || undefined;
		const contentLength = response.headers.get('content-length');

		const nodeStream = Readable.fromWeb(response._data as any);

		return new StreamableFile(nodeStream, {
			length: contentLength !== null ? parseInt(contentLength) : undefined,
			type: contentType,
			disposition: contentDisposition
		});
	}

	@Put('/library/parts/{*path}')
	async putPart (@Req() req: any, @Query() query: any, @Headers() headers: any) {
		return await this.pmsService.plexServerApi(req.path, {
			query,
			headers,
			method: 'PUT',
		})
	}
}
