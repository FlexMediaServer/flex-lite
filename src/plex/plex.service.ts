import { Injectable, OnModuleInit } from '@nestjs/common';
import util from 'util';
import { Metadata } from '../dto/Metadata.entity.js';
import { $Fetch, ofetch } from 'ofetch';
import { normalizeQueryParams } from '../utils/request-values.js';
import EventEmitter from 'events';
import path from 'path';
import { WebdavService } from '../webdav/webdav.service.js';
import crypto from 'node:crypto';
import { db } from '../utils/database.js';
import { MetadataService } from '../metadata/metadata.service.js';
import { StremioService } from '../stremio/stremio.service.js';
//https://plex.example.com/library/metadata/<show ID>/grandchildren - Returns all episodes of a show
//

@Injectable()
export class PMSService implements OnModuleInit {
	endpoint = process.env.PLEX_BASE ?? 'http://localhost:32400'

	eventBus = new EventEmitter()

	public plexServerApi: $Fetch = ofetch.create({
		baseURL: this.endpoint,
		headers: { Accept: 'application/json' },
		retry: 10,
		retryDelay: 1000, // ms
		retryStatusCodes: [500, 429, 408], // response status codes to retry
		timeout: 30000, // Timeout after 3 seconds
		onRequest: ({ options }) => {
			const plexToken = options?.query?.['X-Plex-Token'] || options?.query?.['x-plex-token'];
			options.query = {
				...normalizeQueryParams(options.query),
				'X-Plex-Product': 'Plex Web',
				'X-Plex-Version': '4.159.0',
				'X-Plex-Client-Identifier': 'ubmn93amq1bg3zb2as6le4oe',
				'X-Plex-Platform': 'Chrome',
				'X-Plex-Platform-Version': '146.0',
				'X-Plex-Features': 'external-media,indirect-media,hub-style-list',
				'X-Plex-Model': 'standalone',
				'X-Plex-Device': 'Windows',
				'X-Plex-Token': plexToken ? plexToken : process.env.PLEX_TOKEN,
				'X-Plex-Device-Screen-Resolution': '1055x1066,2195x1235',
				'X-Plex-Provider-Version': '7.2',
				'X-Plex-Text-Format': 'plain',
				'X-Plex-Drm': 'widevine',
				'X-Plex-Language': 'en',
			};
		},
	});

	socket = new WebSocket(this.websocketUri())

	websocketUri () {
		const url = new URL(this.endpoint);
		const wsProtocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
		return `${wsProtocol}//${url.host}/:/websockets/notifications?X-Plex-Token=${process.env.PLEX_TOKEN}`;
	}

	mountPath = '/data'

	localItems = new Map<string, string>()

	libraries = {
		show: '2',
		movie: '1'
	}

	constructor (private webdavService: WebdavService, private metadataService: MetadataService, private stremioService: StremioService) {
		this.socket.addEventListener('message', async event => {
			try {
				const payload = JSON.parse(event.data);
				const ActivityNotification = payload.NotificationContainer?.ActivityNotification?.find((an: any) => an.event === 'ended' && an.Activity.type === 'library.refresh.items')

				// console.log(util.inspect(payload, { depth: null, colors: true }));

				// if (ActivityNotification && ActivityNotification?.Activity?.Context?.key) {
				// 	// console.log(ActivityNotification?.Activity)
				// 	if (ActivityNotification?.Activity?.Context.key.endsWith('/children') || ActivityNotification?.Activity.title === 'Refreshing') return null;
				// 	let item = await this.plexServerApi(`${ActivityNotification?.Activity?.Context.key}`, {
				// 		method: 'GET',
				// 	})

				// 	const { guid, key } = item.MediaContainer?.Metadata?.[0];

				// 	console.log('MEDIA IMPORTED (Activity):', guid, key, ActivityNotification?.Activity)

				// 	this.eventBus.emit(`imported:${guid?.split('/').pop()}`, key.split('/').pop())
				// }

				const timelineEntry = payload.NotificationContainer?.TimelineEntry?.[0];
				//type = 4: Episode
				//type = 1: Movie
				if ((timelineEntry?.state === 5) && (timelineEntry.type === 4 ||  timelineEntry.type === 1)) {
					let item = await this.plexServerApi(`/library/metadata/${timelineEntry.itemID}`, {
						method: 'GET',
					})

					const { guid, key } = item.MediaContainer?.Metadata?.[0];

					console.log('MEDIA IMPORTED (Timeline):', guid, key, timelineEntry)

					this.eventBus.emit(`imported:${guid?.split('/').pop()}`, key.split('/').pop())
				}
				// console.log(util.inspect(payload, { depth: null, colors: true }));
			} catch (e) {
				console.error(e);
			}
		});
		this.socket.addEventListener('open', event => {
			console.log('WebSocket connection established!');
		});
	}

	async onModuleInit () {}

	/**
	 * Sanitizes a string to be safe for use in Windows file paths
	 * Removes or replaces illegal characters: < > : " / \\ | ? *
	 */
	private sanitizePathSegment(segment: string): string {
		// Replace illegal Windows filename characters
		return segment
			.replace(/[<>:"/\\|?*]/g, '_')
			.replace(/\s+/g, ' ')
			.trim();
	}

	async refreshPath (metadata: Metadata, folder: string) {
		const folderPath = path.dirname(path.join(this.mountPath, folder)).replaceAll('\\', '/');
		console.log('Refresh Path:', folderPath)
		if (metadata.type === 'movie') {
			console.log(await this.plexServerApi(`/library/sections/${this.libraries.movie}/refresh`, {
				query: {
					path: folderPath,
				}
			}))
		} else if (metadata.type === 'episode' || metadata.type === 'show') {
			console.log(await this.plexServerApi(`/library/sections/${this.libraries.show}/refresh`, {
				query: {
					path: folderPath,
				}
			}))
		}
	}
	
	async resolveLocalItem (item: Metadata): Promise<Metadata | null> {
		let itemId = (await db.selectFrom('item_mappings').select('item_id').where('guid', '=', item?.guid?.split('/')?.pop() as string).executeTakeFirst())?.item_id;
		if (!itemId) return null;
		try {
			return (await this.plexServerApi(`/library/metadata/${itemId}?checkFiles=1`))?.MediaContainer.Metadata?.[0]
		} catch (e) {
			return null;
		}
	}

	async fillSeries (item: Metadata) {
		if (item.type === 'show') {
			//Plex-Container-Start=62&X-Plex-Container-Size=42
			const showFilePath = `Shows/${item.title}`;

			//Gets children of show (eg. seasons)
			let seasons = await this.metadataService.discoverApi(item.key);
			for (let season of seasons.MediaContainer.Metadata) {
				for (let i = 1; i <= season.leafCount; i++) {
					let episodeFilePath = `${showFilePath}/Season ${season.index}/S${season.index}E${i}/S${season.index}E${i}.mkv`
					await this.webdavService.addFile(episodeFilePath, 'http://192.168.1.13:32401/dummy.mkv');
				}
			}

			await this.refreshPath(item, showFilePath);
		}
	}

	async addStream(item: Metadata, url: string) {
		// Sanitize title segments to remove illegal Windows characters
		const showTitle = this.sanitizePathSegment(item.grandparentTitle || item.parentTitle || 'Unknown').replaceAll('.', '');
		const seasonNum = item.parentIndex?.toString() ?? '0';
		const episodeNum = item.index?.toString() ?? '0';
		const movieTitle = this.sanitizePathSegment(item.title || 'Unknown').replaceAll('.', '');

		// Construct safe path
		const filePath = item.type === 'episode' 
			? `Shows/${showTitle}/Season ${seasonNum}/S${seasonNum}E${episodeNum}/S${seasonNum}E${episodeNum} [${(Math.random() + 1).toString(36).substring(2)}].mkv` 
			: `Movies/${movieTitle} (${item.year})/${movieTitle} (${item.year}).mkv`;
		
		await this.webdavService.addFile(filePath, url);

		const guid = item.guid?.split('/').pop();
		if (!guid) return null; //Should throw an exception

		const itemMapping = await db
			.selectFrom('item_mappings')
			.selectAll()
			.where('guid', '=', guid)
			.executeTakeFirst();

		let itemMappingId: string | undefined;

		if (itemMapping) {
			// Only return the existing item if it is still present in the Plex server
			const existingItem = (await this.resolveLocalItem([item]))[0];

			if (existingItem) {
				itemMappingId = itemMapping.item_id;
			} else {
				await db.deleteFrom('item_mappings').where('guid', '=', guid).execute();
			}
		}

		if (!itemMappingId) {
			const metadataItem = (
				await this.plexServerApi('/library/file', {
					method: 'POST',
					query: {
						url,
						computeHashes: 0,
						ingestNonMatches: 1,
					},
				})
			).MediaContainer.Metadata[0] as Metadata;

			await this.plexServerApi(`${metadataItem.key}/match`, {
				method: 'PUT',
				query: {
					guid: item.guid,
					name: item.title
				}
			})

			itemMappingId = metadataItem?.key.split('/').pop();

			if (itemMappingId) {
				await db
					.insertInto('item_mappings')
					.values({ guid, item_id: itemMappingId, url })
					.onConflict((oc) => oc.column('guid').doUpdateSet({ item_id: itemMappingId, url }))
					.execute();
			}
		}

		this.eventBus.emit(`imported:${guid}`, itemMappingId);

		return itemId;
	}
}
