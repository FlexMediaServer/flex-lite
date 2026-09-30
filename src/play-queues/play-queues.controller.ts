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

@Controller()
export class PlayQueuesController {
	constructor(
		// appService: AppService,
		private metadataService: MetadataService,
		private stremioService: StremioService,
		private pmsService: PMSService,
		// private playbackService: PlaybackService,
		private playQueuesService: PlayQueuesService,
	) {}

	//TODO: If series, make this solely use /grandchildren endpoint on Plex Discover to get all episodes of a series and paginate. Only store playQueue ID and currentItem ID. Cache results

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

		let nextMetadata: Metadata[] = [];
		let currentItem: string | undefined;

		if (item.type == 'show') {
			// start at S1E1 and include next episodes
			const seasons = await this.metadataService.getItemChildren(item?.ratingKey as string); //Get seasons of a show
			nextMetadata = await this.metadataService.getItemChildren(seasons?.[0].ratingKey as string) as Metadata[]; //Get episodes of the first season of the show
			currentItem = nextMetadata.find((episode: Metadata) => episode.index == 1)?.ratingKey as string;

			if (!currentItem) {
				currentItem = nextMetadata[0].ratingKey;
			}
		} else if (item.type == 'season') {
			// start at episode 1 of the season and include next episodes
			nextMetadata = await this.metadataService.getItemChildren(item.ratingKey) as Metadata[]; //Gets season's episodes to populate play queue.

			currentItem = nextMetadata.find((episode: Metadata) => episode.index == item.index)?.ratingKey as string;

			if (!currentItem) {
				currentItem = nextMetadata[0].ratingKey;
			}
		} else if (item.type == 'episode') {
			// return the current episode and next episodes
			nextMetadata = await this.metadataService.getItemChildren(item.parentRatingKey) as Metadata[]; //Gets full season episodes to populate play queue.

			currentItem = nextMetadata.find((episode: Metadata) => episode.ratingKey == item.ratingKey)?.ratingKey as string;

			if (!currentItem) {
				currentItem = nextMetadata[0].ratingKey;
			}
		} else if (item.type == 'movie') {
			// return just the current media
			nextMetadata = [item];

			currentItem = item.ratingKey;
		}

		if (!currentItem) {
			throw new NotFoundException('Could not determine current item for play queue');
		}

		let playQueue = await this.playQueuesService.setPlayQueue(randomInt(0, 1_000_000), {
			currentItem, // todo
			items: nextMetadata,
			playbackSessionId,
		});

		console.debug(`Play queue created... ${playQueue.id}`);

		const currentIndex = playQueue.items?.findIndex((item) => item.ratingKey == playQueue.currentItem);
		const currentItemObj = playQueue.items[currentIndex];
		const stream = await this.stremioService.resolveStream(currentItemObj);
		if (!stream || !stream?.url) throw new NotFoundException()

		const itemPath = await this.pmsService.addStream(item, stream?.url)

		for (let item of playQueue.items) {
			let localItem = await this.pmsService.resolveLocalItem(item)
			if (localItem && localItem.Media?.[0]) {
				item.Media = [localItem.Media[0]]
			} else {
				item.Media = emptyMedia() as any
			}
		}

		// playQueue.items = playQueue.items.slice(currentIndex, currentIndex+100)

		return serializePlayQueues(playQueue, false);
	}

	@Get(['/playQueues/:id'])
	async getPlayQueues(@Param('id') playQueueId: any, @Query('center') center: any) {
		const playQueue = await this.playQueuesService.getPlayQueue(playQueueId);
		if (!playQueue) return new NotFoundException();

		// if (center !== undefined) await this.playQueuesService.selectIndex(playQueue.id, parseInt(center));

		//Fetch play queue again for updated index information
		// playQueue = await this.playQueuesService.getPlayQueue(playQueueId);

		let item = await this.metadataService.getItem(playQueue.currentItem);
		if (!item) throw new NotFoundException()
		let localItem = await this.pmsService.resolveLocalItem(item);
		if (!localItem) {
			const stream = await this.stremioService.resolveStream(item);
			if (!stream || !stream?.url) throw new NotFoundException()
			const path = await this.pmsService.addStream(item, stream?.url)
			localItem = await this.pmsService.resolveLocalItem(item);
		}
		if (!localItem) throw new NotFoundException()


		const currentIndex = playQueue.items.findIndex((item) => item.ratingKey == playQueue.currentItem);
		const currentItem = playQueue.items[currentIndex];

		for (let item of playQueue.items) {
			item.Media = emptyMedia() as any
		}		

		let currentLocalItem = await this.pmsService.resolveLocalItem(item)
		if (currentLocalItem && currentLocalItem.Media?.[0]) {
			currentItem.Media = [currentLocalItem.Media[0]]
		} else {
			currentItem.Media = emptyMedia() as any
		}

		// playQueue.items = playQueue.items.slice(currentIndex, currentIndex+100)

		return serializePlayQueues(playQueue, false);
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
			if (playQueue.currentItem !== query.playQueueItemID) {
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

		console.log(query)

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

		const directPlay = process.env.ALLOW_DIRECT_PLAY === 'true';

		query.path = localItem.key
		if (query.videoResolution === '') query.videoResolution = '1080x1080'

		await this.pmsService.plexServerApi(req.path, {
			method: 'GET',
			query,
			headers
		})

		return {
			MediaContainer: new MediaContainer({
				allowSync: true,

				directPlayDecisionCode: directPlay ? 1000 : 3000,
				directPlayDecisionText: directPlay ? 'Direct play OK.' : 'App cannot direct play this item. Direct play is disabled.',

				mdeDecisionCode: directPlay ? 1000 : 3000,
				mdeDecisionText: directPlay ? 'Direct play OK.' : 'App cannot direct play this item. Direct play is disabled.',

				generalDecisionCode: directPlay ? 1000 : 1000,
				generalDecisionText: directPlay ? 'Direct play OK.' : 'Direct play not available; Conversion OK.',

				transcodeDecisionCode: !directPlay ? 1001 : undefined,
				transcodeDecisionText: !directPlay ? 'Direct play not available; Conversion OK.' : undefined,

				identifier: 'com.plexapp.plugins.library',

				mediaTagPrefix: '/system/bundle/media/flags/',
				mediaTagVersion: 1731522690,
				resourceSession: query.session,

				[isXML ? 'Video' : 'Metadata']: [
					new Metadata({
						...item,

						Media: [localItem.Media[0]],
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
		console.log(localItem, item)
		if (!localItem) throw new NotFoundException('Local item not found')

		// const newQuery: any = {}
		query.path = localItem.key
		// newQuery.protocol = query.protocol
		// query.location = 'lan' //To prevent Plex from limiting transcode quality to 480p
		// query.session = Date.now().toString(36) + Math.random().toString(36).substring(2);
		// query['X-Plex-Playback-Id'] = undefined;
		// query['X-Plex-Playback-Session-Id'] = undefined;
		// query['X-Plex-Session-Id'] = undefined;
		// query['X-Plex-Session-Identifier'] = undefined;
		// newQuery['X-Plex-Client-Identifier'] = Date.now().toString(36) + Math.random().toString(36).substring(2);
		// console.log(newQuery)
		// query.session = undefined;
		// query['X-Plex-Session-Id'.toLowerCase()] = undefined;
		// query['X-Plex-Playback-Session-Id'.toLowerCase()] = undefined;
		// query['X-Plex-Playback-Id'.toLowerCase()] = undefined;
		console.log(req.baseUrl + req.path, localItem.key)
		let response = await this.pmsService.plexServerApi(req.baseUrl + req.path, {
			query,
			headers
		})

		// Get response array buffer or stream and send it
		const buffer = await response.arrayBuffer();
		res.send(Buffer.from(buffer));
	}

	@Get('/library/parts/{*path}')
	async getPart (@Req() req: any, @Res({ passthrough: true }) res: any, @Query() query: any, @Headers() headers: any) {
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

		// 2. Extract headers from the response object
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
