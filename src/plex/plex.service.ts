import { Injectable, OnModuleInit } from '@nestjs/common';
import { Metadata } from '../dto/Metadata.entity.js';
import { $Fetch, ofetch } from 'ofetch';
import { normalizeParams } from '../utils/request-values.js';
import { getMediaNotFoundUrl } from '../utils/media-not-found.js';
import { DEFAULT_PLAYED_THRESHOLD, playedThresholdFrom } from './played-threshold.js';
import path from 'path';
import { readFile } from 'node:fs/promises';
import { db } from '../utils/database.js';
import { MetadataService } from '../metadata/metadata.service.js';
import { StremioService } from '../stremio/stremio.service.js';
import { parseStringPromise } from 'xml2js';
import { PROXY } from '../main.js';

//item_mappings.guid for the one Plex copy of the not found video that every such item shares.
const NOT_FOUND_SHARED = 'flex:not-found';


@Injectable()
export class PMSService implements OnModuleInit {
	endpoint = process.env.PLEX_BASE ?? 'http://localhost:32400'

	public plexServerApi: $Fetch = ofetch.create({
		baseURL: this.endpoint,
		headers: { Accept: 'application/json' },
		retry: 10,
		retryDelay: 1000, // ms
		retryStatusCodes: [500, 429, 408], // response status codes to retry
		timeout: 30000, // ms
		onRequest: ({ options }) => {
			options.query = {
				...normalizeParams(options.query),
				'x-plex-token': this.plexToken
			};

			options.headers.set('x-plex-token', this.plexToken)
		},
	});

	constructor() {}

	//Calls the Plex server as the requesting user, so per-user results (continue watching, search) match what that user sees
	plexUserApi(token: string): $Fetch {
		return ofetch.create({
			baseURL: this.endpoint,
			headers: { Accept: 'application/json' },
			timeout: 30000, // ms
			onRequest: ({ options }) => {
				options.query = { ...normalizeParams(options.query), 'x-plex-token': token };
				options.headers.set('x-plex-token', token);
			},
		});
	}

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

		//The Plex item is only deleted once no other mapping points at it. The shared not found copy is referenced by its own row, so it is never deleted here.
		if (itemMapping) {
			const otherMapping = await db
				.selectFrom('item_mappings')
				.select('guid')
				.where('item_id', '=', itemMapping.item_id)
				.where('guid', '!=', guid)
				.executeTakeFirst();

			if (!otherMapping) {
				try {
					await this.plexServerApi(`/library/metadata/${itemMapping.item_id}`, { method: 'DELETE' });
				} catch (error: any) {
					//Already gone from Plex, so only the mapping needs cleaning up
					if (error?.status !== 404) throw error;
				}
			}
		}

		await db.deleteFrom('item_mappings').where('guid', '=', guid).execute();
	}

	//Ingests a stream URL into the Plex library via POST /library/file, then matches the new item to the Plex metadata guid.
	//The mapping is stored so later resolves reuse the same item instead of re-ingesting.
	async addStream(item: Metadata, url: string) {
		const guid = item.guid?.split('/').pop();
		if (!guid) return null; // Should throw an exception

		const itemMapping = await db
			.selectFrom('item_mappings')
			.selectAll()
			.where('guid', '=', guid)
			.executeTakeFirst();

		let itemMappingId: string | undefined;

		//A not found mapping points at the shared copy, so it is replaced by the new ingest rather than reused
		if (itemMapping && !(await this.isNotFoundItem(item))) {
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

			itemMappingId = metadataItem?.key.split('/').pop();

			if (itemMappingId) {
				await db
					.insertInto('item_mappings')
					.values({ guid, item_id: itemMappingId, url })
					.onConflict((oc) => oc.column('guid').doUpdateSet({ item_id: itemMappingId, url }))
					.execute();
			}
		}

		return itemMappingId;
	}

	//Maps an item to the shared not found copy with the actual video url, and returns that copy's Plex metadata for playback.
	async addNotFound(item: Metadata): Promise<Metadata | null> {
		const guid = item.guid?.split('/').pop();
		if (!guid) return null;

		const sharedId = await this.getSharedNotFoundId();

		await db
			.insertInto('item_mappings')
			.values({ guid, item_id: sharedId, url: getMediaNotFoundUrl() })
			.onConflict((oc) => oc.column('guid').doUpdateSet({ item_id: sharedId, url: getMediaNotFoundUrl() }))
			.execute();

		return this.getNotFoundItem();
	}

	//The server's played threshold, as a fraction of an item. Read from the server's prefs and cached for an hour.
	private playedThresholdCache?: { value: number; fetchedAt: number };

	async playedThreshold(): Promise<number> {
		if (this.playedThresholdCache && Date.now() - this.playedThresholdCache.fetchedAt < 3600 * 1000) return this.playedThresholdCache.value;

		try {
			const response = await this.plexServerApi('/:/prefs');
			const value = playedThresholdFrom(response?.MediaContainer?.Setting);
			this.playedThresholdCache = { value, fetchedAt: Date.now() };
			return value;
		} catch (error: any) {
			//Not cached, so the next playback tries the server again
			console.error(`Could not read the played threshold: ${error?.message ?? error}`);
			return DEFAULT_PLAYED_THRESHOLD;
		}
	}

	//True when the item is being served the shared not found copy rather than its own media. Compared by Plex id, not url, so mappings made before a url change are still recognised.
	async isNotFoundItem(item: Metadata): Promise<boolean> {
		const guid = item.guid?.split('/').pop();
		if (!guid) return false;

		const mapping = await db
			.selectFrom('item_mappings')
			.select('item_id')
			.where('guid', '=', guid)
			.executeTakeFirst();

		if (!mapping) return false;
		return mapping.item_id === (await this.getSharedNotFoundRow())?.item_id;
	}

	private async getSharedNotFoundRow(): Promise<{ item_id: string; url: string } | undefined> {
		return await db
			.selectFrom('item_mappings')
			.select(['item_id', 'url'])
			.where('guid', '=', NOT_FOUND_SHARED)
			.executeTakeFirst();
	}

	//Returns the Plex metadata of the shared not found copy.
	async getNotFoundItem(): Promise<Metadata> {
		const sharedId = await this.getSharedNotFoundId();
		return (await this.plexServerApi(`/library/metadata/${sharedId}`)).MediaContainer.Metadata[0] as Metadata;
	}

	private pendingNotFound?: Promise<string>;

	//Concurrent resolves share one ingest of the not found video.
	private getSharedNotFoundId(): Promise<string> {
		this.pendingNotFound ??= this.ensureSharedNotFound().finally(() => {
			this.pendingNotFound = undefined;
		});

		return this.pendingNotFound;
	}

	//Ingests the not found video once and keeps its Plex id under NOT_FOUND_SHARED. The copy is never matched to a metadata item, so it stays unattached.
	//The copy keeps the url it was ingested with, so when the configured url changes it is deleted and ingested again.
	private async ensureSharedNotFound(): Promise<string> {
		const url = getMediaNotFoundUrl();
		const existing = await this.getSharedNotFoundRow();

		if (existing && existing.url === url && (await this.plexItemExists(existing.item_id))) return existing.item_id;
		if (existing) await this.deleteSharedNotFound(existing.item_id);

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

		const sharedId = metadataItem.key.split('/').pop() as string;

		await db
			.insertInto('item_mappings')
			.values({ guid: NOT_FOUND_SHARED, item_id: sharedId, url })
			.onConflict((oc) => oc.column('guid').doUpdateSet({ item_id: sharedId, url }))
			.execute();

		return sharedId;
	}

	//Deletes the shared copy from Plex and drops every mapping to it. Items mapped to it are resolved again on their next play.
	private async deleteSharedNotFound(itemId: string): Promise<void> {
		try {
			await this.plexServerApi(`/library/metadata/${itemId}`, { method: 'DELETE' });
		} catch (error: any) {
			//Already gone from Plex, so only the mappings need cleaning up
			if (error?.status !== 404) throw error;
		}

		await db.deleteFrom('item_mappings').where('item_id', '=', itemId).execute();
	}

	private async plexItemExists(itemId: string): Promise<boolean> {
		try {
			const response = await this.plexServerApi(`/library/metadata/${itemId}`);
			return (response?.MediaContainer?.Metadata?.length ?? 0) > 0;
		} catch (error: any) {
			if (error?.status === 404) return false;
			throw error;
		}
	}
}
