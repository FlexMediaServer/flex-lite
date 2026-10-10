import { Injectable, OnModuleInit } from '@nestjs/common';
import { Metadata } from '../dto/Metadata.entity.js';
import { $Fetch, ofetch } from 'ofetch';
import { normalizeParams } from '../utils/request-values.js';
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
			options.query = {
				...normalizeParams(options.query),
				'x-plex-token': this.plexToken
			};

			options.headers.set('x-plex-token', this.plexToken)
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

	
	//Resolves items to their local Plex metadata in one batch. Returns results aligned with the input array (null when unresolved).
	async resolveLocalItem (items: Metadata[]): Promise<(Metadata | null)[]> {
		const itemIds = items.map((item) => item?.guid?.split('/')?.pop());
		const guids = [...new Set(itemIds.filter((guid): guid is string => !!guid))];

		const guidToItemId = new Map(
			(
				guids.length
					? await db
						.selectFrom('item_mappings')
						.select(['guid', 'item_id'])
						.where('guid', 'in', guids)
						.execute()
					: []
			).map((mapping) => [mapping.guid, mapping.item_id]),
		);

		const resolvedIds = [...new Set(itemIds.map((itemId) => itemId && guidToItemId.get(itemId)).filter((id): id is string => !!id))];

		if (!resolvedIds.length) return items.map(() => null);

		//Plex accepts comma separated item IDs for batch metadata fetches.
		let resolvedById: Map<string | undefined, Metadata>;
		try {
			const metadata = (await this.plexServerApi(`/library/metadata/${resolvedIds.join(',')}`))?.MediaContainer?.Metadata ?? [];
			resolvedById = new Map(metadata.map((item: Metadata) => [item.ratingKey?.split('/').pop(), item]));
		} catch {
			return items.map(() => null);
		}

		return itemIds.map((itemId) => resolvedById.get((itemId && guidToItemId.get(itemId)) ?? '') ?? null);
	}

	//Returns the stream URL a local item was ingested from, or null when the item was not added through addStream.
	async resolveMappedUrl (item: Metadata): Promise<string | null> {
		const guid = item.guid?.split('/').pop();
		if (!guid) return null;

		const itemMapping = await db
			.selectFrom('item_mappings')
			.select('url')
			.where('guid', '=', guid)
			.executeTakeFirst();

		return itemMapping?.url ?? null;
	}

	//Deletes the mapped item from the Plex server, then the mapping. Plex is deleted first so a failure keeps the mapping and the next resolve retries.
	async removeMapping (item: Metadata) {
		const guid = item.guid?.split('/').pop();
		if (!guid) return;

		const itemMapping = await db
			.selectFrom('item_mappings')
			.select('item_id')
			.where('guid', '=', guid)
			.executeTakeFirst();

		if (itemMapping) {
			try {
				await this.plexServerApi(`/library/metadata/${itemMapping.item_id}`, { method: 'DELETE' });
			} catch (error: any) {
				//Already gone from Plex, so only the mapping needs cleaning up
				if (error?.status !== 404) throw error;
			}
		}

		await db.deleteFrom('item_mappings').where('guid', '=', guid).execute();
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

		return itemMappingId;
	}
}
