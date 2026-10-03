import { Post, Query, Headers, Res, NotFoundException, Controller, Get, Param, InternalServerErrorException, Put, Delete, Req, StreamableFile, Header } from '@nestjs/common';
import { randomInt } from 'node:crypto';
import { PlayQueuesQuery } from './play-queues.dto.js';
import { parseKey } from '../utils/generic.js';
import { MetadataService } from '../metadata/metadata.service.js';
import { StremioService } from '../stremio/stremio.service.js';
import { PMSService } from '../plex/plex.service.js';
import { PlayQueuesService } from './play-queues.service.js';
import { Metadata } from '../dto/Metadata.entity.js';
import { emptyMedia, serializePlayQueues } from '../utils/plex.js';
import { Readable } from 'node:stream';
import { MediaContainer } from '../dto/MediaContainer.entity.js';
import { IsXML } from '../is-xml.decorator.js';
import { AppService } from '../app.service.js';
import util from 'util';

@Controller()
export class PlayQueuesController {
	constructor(
		private appService: AppService,
		private metadataService: MetadataService,
		private stremioService: StremioService,
		private pmsService: PMSService,
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

		const playbackSessionId =
			headers['x-plex-playback-session-id'] ||
			query['x-plex-playback-session-id'] ||
			headers['x-plex-session-id'] ||
			query['x-plex-session-id'];

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

		const itemPath = await this.appService.resolveMedia(currentItemObj);
		if (!itemPath) throw new NotFoundException();

		for (const windowItem of window.items) {
			if (windowItem === currentItemObj) {
				const localItem = await this.pmsService.resolveLocalItem(windowItem);
				windowItem.Media = localItem?.Media?.[0] ? [localItem.Media[0]] : (emptyMedia() as any);
			} else {
				windowItem.Media = emptyMedia() as any;
			}
		}

		return serializePlayQueues(playQueue, window, false);
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

		let localItem = await this.pmsService.resolveLocalItem(currentItem);
		if (!localItem) {
			await this.appService.resolveMedia(currentItem);
			localItem = await this.pmsService.resolveLocalItem(currentItem);
		}
		if (!localItem) throw new NotFoundException();

		for (const windowItem of window.items) {
			windowItem.Media = emptyMedia() as any;
		}

		if (localItem?.Media?.[0]) {
			currentItem.Media = [localItem.Media[0]];
		}

		return serializePlayQueues(playQueue, window, false);
	}

	@Get('/library/metadata/:id/userState')
	userState() {}

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
	) {
		const playbackSessionId =
			headers['x-plex-playback-session-id'] ||
			query['x-plex-playback-session-id'] ||
			headers['x-plex-session-id'] ||
			query['x-plex-session-id'];

		const playQueue = await this.playQueuesService.getPlayQueueByPlaybackSession(playbackSessionId);

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

		let localItem = await this.pmsService.resolveLocalItem(item);
		if (!localItem) return new NotFoundException()

		query.path = localItem.key
		query.key = localItem.key
		query.guid = item.guid
		query.ratingKey = localItem.key.split('/').pop()

		if (query['X-Plex-Device'] === '') delete query['X-Plex-Device']

		return await this.pmsService.plexServerApi('/:/timeline', {
			query,
			headers
		})
	}

	@Get('/:id/scrobble')
	async scrobble(
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

		const item = await this.metadataService.getItem(query.key);
		if (!item) throw new NotFoundException();

		let localItem = await this.pmsService.resolveLocalItem(item);
		if (!localItem) return new NotFoundException()

		query.key = localItem.key.split('/').pop()

		// console.log(query)

		return await this.pmsService.plexServerApi('/:/scrobble', {
			method: 'GET',
			query,
			headers
		})
	}


	@Get('/video/:id/transcode/universal/decision')
	async decision (@Req() req: any, @Query() query: any, @Headers() headers: any, @IsXML() isXML: boolean) {
		const itemId = query.path.split('/').pop()
		let item = await this.metadataService.getItem(itemId)
		if (!item) throw new NotFoundException()
		let localItem = await this.pmsService.resolveLocalItem(item);
		if (!localItem || localItem.Media?.[0] === undefined) throw new NotFoundException()

		query.path = localItem.key
		if (query.videoResolution === '') query.videoResolution = '1080x1080'
		if (query['X-Plex-Device'] === '') delete query['X-Plex-Device']

		const decision = await this.pmsService.plexServerApi(req.path, {
			method: 'GET',
			query,
			headers
		});

		// console.log(decision.MediaContainer.Metadata[0].Media[0],{showHidden: false, depth: null, colors: true})

		const Media = {...decision.MediaContainer?.Metadata[0].Media[0]}

		if (decision.MediaContainer) {
			decision.MediaContainer.Metadata = undefined;
			decision.MediaContainer.size = undefined;
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
		const itemId = query.path.split('/').pop()
		let item = await this.metadataService.getItem(itemId)
		if (!item) throw new NotFoundException('Plex metadata item not found')

		let localItem = await this.pmsService.resolveLocalItem(item);
		if (!localItem) throw new NotFoundException('Local item not found')

		query.path = localItem.key
		if (query['X-Plex-Device'] === '') delete query['X-Plex-Device']

		if (req.path.includes('.mpd') || req.path.includes('.m3u8')) {
			const arrayBuffer = await this.pmsService.plexServerApi(req.baseUrl + req.path, {
				query,
				headers,
				responseType: 'arrayBuffer'
			});

			const buffer = Buffer.from(arrayBuffer);

			return res.status(200).send(buffer);
		}

		console.log(req.baseUrl + req.path, localItem.key)
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
