import { forwardRef, Inject, Injectable } from '@nestjs/common';
import { normalizeQueryParams } from '../utils/request-values.js';
import { ofetch, type $Fetch } from 'ofetch';
import { cache, db, isSqlite } from '../utils/database.js';
import { Metadata } from '../dto/Metadata.entity.js';
import { Hub } from '../dto/Hub.entity.js';
import { PMSService } from '../plex/plex.service.js';
import { Cron, CronExpression } from '@nestjs/schedule';
import { StremioService } from '../stremio/stremio.service.js';
import type { StremioService as StremioServiceType } from '../stremio/stremio.service.js';
import { StremioMeta } from '../stremio/stremio.js';

@Injectable()
export class MetadataService {

	constructor (private pmsService: PMSService, @Inject(forwardRef(() => StremioService)) private stremioService: StremioServiceType) {}

	public hubs: Hub[] = [];

	public discoverApi: $Fetch = ofetch.create({
		baseURL: 'https://discover.provider.plex.tv',
		headers: { Accept: 'application/json' },
		retry: 10,
		retryDelay: 1000, // ms
		retryStatusCodes: [500, 429, 408], // response status codes to retry
		timeout: 30000, // Timeout after 3 seconds
		onRequest: ({ options }) => {
			options.query = {
				...normalizeQueryParams(options.query),
				// 'X-Plex-Product': 'Plex Web',
				// 'X-Plex-Version': '4.159.0',
				// 'X-Plex-Platform': 'Chrome',
				// 'X-Plex-Platform-Version': '146.0',
				// 'X-Plex-Features': 'external-media,indirect-media,hub-style-list',
				// 'X-Plex-Model': 'standalone',
				// 'X-Plex-Device': 'Windows',
				// 'X-Plex-Device-Screen-Resolution': '1055x1066,2195x1235',
				'X-Plex-Token': this.pmsService.plexToken,
				// 'X-Plex-Provider-Version': '7.2',
				// 'X-Plex-Text-Format': 'plain',
				// 'X-Plex-Drm': 'widevine',
				// 'X-Plex-Language': 'en',
			};
		},
	});

	@Cron(CronExpression.EVERY_12_HOURS)
	async syncStremioCatalogs(): Promise<void> {
		const manifest = this.stremioService.getManifest();
		if (!manifest) return;

		console.info('Syncing Stremio Catalogs');
		const catalogs = await this.stremioService.getCatalogs(true);
		console.info('Fetched Stremio Catalogs');

		const hubs: Hub[] = [];

		for (const catalog of catalogs) {
			if (!catalog.metas?.length) continue;

			console.debug(`Resolving Catalog: ${catalog.type} | ${catalog.id}`);

			const resolved: (Metadata | null)[] = [];
			for (const meta of catalog.metas) {
				try {
					resolved.push(await this.findPlexMetadataForStremioMeta(meta));
				} catch (e) {
					console.error(e);
					resolved.push(null);
				}
			}

			const hits = resolved.filter((item): item is Metadata => item !== null);

			hubs.push(
				new Hub({
					style: 'shelf',
					promoted: true,
					hubIdentifier: `stremio.${catalog.type}.${catalog.id}`,
					hubKey: `/library/metadata/${hits.map((metadata) => metadata.ratingKey).join(',')}`,
					key: `/hubs/stremio.${catalog.type}.${catalog.id}/items`,
					context: `hub.stremio.${catalog.type}.${catalog.id}`,
					more: false,
					title: `${catalog.name} - ${catalog.type === 'movie' ? 'Movies' : 'Shows'}`,
					type: catalog.type === 'movie' ? 'movie' : catalog.type === 'series' ? 'show' : 'mixed',
					Metadata: hits.length > 0 ? hits : undefined,
				}),
			);
		}

		this.hubs = hubs;

		console.info('Stremio Catalogs Complete');
	}

	async findPlexMetadataForStremioMeta(stremioMeta: StremioMeta): Promise<Metadata | null> {
		const isMovie = stremioMeta.type === 'movie';
		const plexType = isMovie ? 1 : 2;

		const imdbId = stremioMeta.imdb_id || (stremioMeta.id?.startsWith('tt') ? stremioMeta.id : null);
		const tmdbId = stremioMeta.moviedb_id ? String(stremioMeta.moviedb_id) : null;

		let cachedMatch = null;

		if (imdbId || tmdbId) {
			cachedMatch = await db
				.selectFrom('metadata')
				.selectAll()
				.where((eb) => eb.or([eb('imdb_id', '=', imdbId), eb('tmdb_id', '=', tmdbId)]))
				.orderBy('updated_at', 'desc')
				.executeTakeFirst();
		}

		if (cachedMatch?.data) {
			const cachedData = typeof cachedMatch.data === 'string' ? JSON.parse(cachedMatch.data) : cachedMatch.data;
			return new Metadata(cachedData);
		}

		const body: Record<string, string | number> = isMovie
			? {
					excludeElements: 'Media',
					type: plexType,
					title: stremioMeta.name,
					filename: `${stremioMeta.name}.mp4`,
				}
			: {
					type: plexType,
					parentTitle: stremioMeta.name,
					includeChildren: 1,
					episodeOrder: 'tmdbAiring',
					filename: `${stremioMeta.name}.mp4`,
					includeElements: 'Directory,Children,Video,Guid',
					includeFields: 'guid,parentGuid,title,parentTitle,thumb,parentThumb,index,originallyAvailableAt,year,type',
				};

		let candidates: Metadata[];
		try {
			const response = await this.discoverApi<{ MediaContainer?: { Metadata?: Metadata[] } }>(
				'https://metadata.provider.plex.tv/library/metadata/matches',
				{
					method: 'POST',
					body,
				},
			);
			candidates = response.MediaContainer?.Metadata ?? [];
		} catch {
			return null;
		}

		if (!candidates.length) return null;

		const knownIds = new Set<string>();
		if (imdbId) knownIds.add(`imdb://${imdbId}`);
		if (tmdbId) knownIds.add(`tmdb://${tmdbId}`);

		const match = candidates.find((candidate) => candidate.Guid?.some((g) => knownIds.has(g.id)));

		if (!match?.guid) return null;

		const plexId = match.guid.split('/').pop();
		if (!plexId) return null;
		const item = await this.getItem(plexId);
		if (!item) return null;

		const imdbGuid = match.Guid?.find((g) => g.id.startsWith('imdb://'))?.id?.replace('imdb://', '') || imdbId;
		const tmdbGuid = match.Guid?.find((g) => g.id.startsWith('tmdb://'))?.id?.replace('tmdb://', '') || tmdbId;
		const tvdbGuid = match.Guid?.find((g) => g.id.startsWith('tvdb://'))?.id?.replace('tvdb://', '');

		await this.upsertMetadataCacheEntry({
			id: plexId,
			imdbId: imdbGuid ?? null,
			tmdbId: tmdbGuid ?? null,
			tvdbId: tvdbGuid ?? null,
			data: item,
		});

		return item;
	}
	
	private async upsertMetadataCacheEntry(params: {
		id: string;
		imdbId?: string | null;
		tmdbId?: string | null;
		tvdbId?: string | null;
		data: unknown;
	}): Promise<void> {
		const { id, imdbId = null, tmdbId = null, tvdbId = null, data } = params;
		const now = Math.floor(Date.now() / 1000);
		const dataPayload = isSqlite ? JSON.stringify(data) : data;

		const existing = await db
			.selectFrom('metadata')
			.selectAll()
			.where((eb) =>
				eb.or([
					eb('id', '=', id),
					...(imdbId ? [eb('imdb_id', '=', imdbId)] : []),
					...(tmdbId ? [eb('tmdb_id', '=', tmdbId)] : []),
					...(tvdbId ? [eb('tvdb_id', '=', tvdbId)] : []),
				]),
			)
			.orderBy('updated_at', 'desc')
			.executeTakeFirst();

		if (existing) {
			await db
				.updateTable('metadata')
				.set({
					imdb_id: imdbId ?? existing.imdb_id,
					tmdb_id: tmdbId ?? existing.tmdb_id,
					tvdb_id: tvdbId ?? existing.tvdb_id,
					data: dataPayload,
					updated_at: now,
				})
				.where('id', '=', existing.id)
				.execute();
		} else {
			await db
				.insertInto('metadata')
				.values({
					id,
					imdb_id: imdbId,
					tmdb_id: tmdbId,
					tvdb_id: tvdbId,
					data: dataPayload,
					created_at: now,
					updated_at: now,
				})
				.execute();
		}
	}

	async getItem(id: string, noCache = false): Promise<Metadata | null> {
		let item = noCache ? null : await cache.get(`metadata:${id}`);

		if (!item) {
			const dbRecord = noCache ? null : await db.selectFrom('metadata').select(['data']).where('id', '=', id).executeTakeFirst();

			if (dbRecord?.data) {
				item = typeof dbRecord.data === 'string' ? JSON.parse(dbRecord.data) : dbRecord.data;
			} else {
				try {
					item = (
						await this.discoverApi<{ MediaContainer?: { Metadata?: Metadata[] } }>(
							`/library/metadata/${encodeURIComponent(id)}`,
							{
								query: {
									includeConcerts: 1,
									includeExtras: 1,
									includeOnDeck: 1,
									includePopularLeaves: 1,
									includePreferences: 1,
									includeReviews: 1,
									includeChapters: 1,
									includeStations: 1,
									includeExternalMedia: 1,
									asyncAugmentMetadata: 1,
									asyncCheckFiles: 1,
									asyncRefreshAnalysis: 1,
									asyncRefreshLocalMediaAgent: 1,
								},
							},
						)
					)?.MediaContainer?.Metadata?.[0];
				} catch {
					return null;
				}

				if (item?.Media) {
					delete item.Media;
				}

				if (item) {
					const imdbGuid = item.Guid?.find((g: any) => g.id.startsWith('imdb://'))?.id?.replace('imdb://', '') || null;
					const tmdbGuid = item.Guid?.find((g: any) => g.id.startsWith('tmdb://'))?.id?.replace('tmdb://', '') || null;
					const tvdbGuid = item.Guid?.find((g: any) => g.id.startsWith('tvdb://'))?.id?.replace('tvdb://', '') || null;

					await this.upsertMetadataCacheEntry({
						id,
						imdbId: imdbGuid,
						tmdbId: tmdbGuid,
						tvdbId: tvdbGuid,
						data: item,
					});
				}
			}

			if (!noCache && item) {
				await cache.set(`metadata:${id}`, item, 3600 * 1000);
			}
		}

		if (!item) return null;

		return item;
	}

	async getItemChildren(id: string, limit = 100, offset = 0): Promise<Metadata[] | null> {
		const result = await this.discoverApi<{ MediaContainer?: { Metadata?: Metadata[] } }>(
			`/library/metadata/${id}/children`,
			{
				query: {
					excludeAllLeaves: 1,
					'X-Plex-Container-Size': limit,
					'X-Plex-Container-Start': offset
				},
			},
		);

		if (!result) return null;

		if (result?.MediaContainer?.Metadata) {
			for (const item of result?.MediaContainer?.Metadata) {
				if (item.Media) {
					delete item.Media;
				}
			}
		}

		return result?.MediaContainer?.Metadata as Metadata[];
	}


	async getItemGrandchildren(id: string, limit = 100, offset = 0): Promise<{ metadata: Metadata[]; totalSize: number } | null> {
		const result = await this.discoverApi<{ MediaContainer?: { Metadata?: Metadata[]; totalSize?: number } }>(
			`/library/metadata/${id}/grandchildren`,
			{
				query: {
					excludeAllLeaves: 1,
					'X-Plex-Container-Size': limit,
					'X-Plex-Container-Start': offset
				},
			},
		);

		if (!result) return null;

		if (result?.MediaContainer?.Metadata) {
			for (const item of result?.MediaContainer?.Metadata) {
				if (item.Media) {
					delete item.Media;
				}
			}
		}

		return {
			metadata: (result?.MediaContainer?.Metadata ?? []) as Metadata[],
			totalSize: result?.MediaContainer?.totalSize ?? 0,
		};
	}
}
