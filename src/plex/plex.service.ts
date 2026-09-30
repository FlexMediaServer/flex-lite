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

	mountPath = '/data'

	localItems = new Map<string, string>()

	libraries = {
		show: '2',
		movie: '1'
	}

	constructor (private webdavService: WebdavService, private metadataService: MetadataService, private stremioService: StremioService) {
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
		// const showTitle = this.sanitizePathSegment(item.grandparentTitle || item.parentTitle || 'Unknown').replaceAll('.', '');
		// const seasonNum = item.parentIndex?.toString() ?? '0';
		// const episodeNum = item.index?.toString() ?? '0';
		// const movieTitle = this.sanitizePathSegment(item.title || 'Unknown').replaceAll('.', '');
		const guid = item.guid?.split('/').pop();
		if (!guid) return null; //Should throw an exception

		let itemMapping = (await db.selectFrom('item_mappings').selectAll().where('guid', '=', guid).executeTakeFirst());
		let itemMappingId;

		if (!itemMapping) {
			let metadataItem = (await this.plexServerApi('/library/file', {
				method: 'POST',
				query: {
					url,
					computeHashes: 0,
					ingestNonMatches: 1
				}
			})).MediaContainer.Metadata[0] as Metadata

			// await this.plexServerApi(`${metadataItem.key}/match`, {
			// 	method: 'PUT',
			// 	query: {
			// 		guid: item.guid,
			// 		name: item.title
			// 	}
			// })

			let m = metadataItem?.key.split('/').pop();
			itemMappingId = m

			await db
				.insertInto('item_mappings')
				.values({ guid: guid, item_id: m as string })
				.onConflict((oc) => 
					oc.column('guid').doUpdateSet({ item_id: m })
				).execute();

			this.eventBus.emit(`imported:${guid}`, itemMappingId)
		} else {
			itemMappingId = itemMapping.item_id
			this.eventBus.emit(`imported:${guid}`, itemMapping.item_id)
		}


		return itemMappingId;
	}
}
