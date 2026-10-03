import { Injectable, OnModuleInit } from '@nestjs/common';
import { Metadata } from '../dto/Metadata.entity.js';
import { $Fetch, ofetch } from 'ofetch';
import { normalizeQueryParams } from '../utils/request-values.js';
import EventEmitter from 'events';
import path from 'path';
import { readFile } from 'node:fs/promises';
import { db } from '../utils/database.js';
import { MetadataService } from '../metadata/metadata.service.js';
import { StremioService } from '../stremio/stremio.service.js';
import { parseStringPromise } from 'xml2js';
import { PROXY } from '../main.js';

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
				'X-Plex-Token': plexToken ? plexToken : this.plexToken
			};
		},
	});

	constructor() {}

	public plexToken: string;

	async onModuleInit() {
		this.preferences = await this.loadPreferencesFile();
		this.plexToken = this.preferences?.Preferences?.$?.PlexOnlineToken
		if (this.plexToken) PROXY.enabled = true;
	}

	private preferences: any;

	async loadPreferencesFile () {
		const preferencesPath = process.env.PLEX_PREFERENCES_PATH;
		if (!preferencesPath) return null;

		const xml = await readFile(preferencesPath, 'utf8');
		return await parseStringPromise(xml);
	}

	// users: any = {};
	// async getUser (token: string) {
	// 	let user = this.users[token]

	// 	if (!user) {
	// 		user = await ofetch('https://plex.tv/api/v2/user', {
	// 			headers: {
	// 				Accept: 'application/json',
	// 				'X-Plex-Token': token
	// 			}
	// 		});
	// 		this.users[token] = user;
	// 	}

	// 	return user
	// }
	
	async resolveLocalItem(item: Metadata): Promise<Metadata | null> {
		const guid = item?.guid?.split('/')?.pop();
		if (!guid) return null;

		const itemId = (
			await db
				.selectFrom('item_mappings')
				.select('item_id')
				.where('guid', '=', guid)
				.executeTakeFirst()
		)?.item_id;

		if (!itemId) return null;

		try {
			return (await this.plexServerApi(`/library/metadata/${itemId}`))?.MediaContainer?.Metadata?.[0] ?? null;
		} catch {
			return null;
		}
	}

	async addStream(item: Metadata, url: string) {
		const guid = item.guid?.split('/').pop();
		if (!guid) return null; // Should throw an exception

		const itemMapping = await db
			.selectFrom('item_mappings')
			.selectAll()
			.where('guid', '=', guid)
			.executeTakeFirst();

		let itemMappingId: string | undefined;

		if (itemMapping) {
			// Only return the existing item if it is still present in the Plex server
			const existingItem = await this.resolveLocalItem(item);

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

			// await this.plexServerApi(`${metadataItem.key}/match`, {
			// 	method: 'PUT',
			// 	query: {
			// 		guid: item.guid,
			// 		name: item.title
			// 	}
			// })

			itemMappingId = metadataItem?.key.split('/').pop();

			if (itemMappingId) {
				await db
					.insertInto('item_mappings')
					.values({ guid, item_id: itemMappingId })
					.onConflict((oc) => oc.column('guid').doUpdateSet({ item_id: itemMappingId }))
					.execute();
			}
		}

		this.eventBus.emit(`imported:${guid}`, itemMappingId);

		return itemMappingId;
	}
}
