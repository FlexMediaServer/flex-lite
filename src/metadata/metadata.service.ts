import { forwardRef, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { sql } from 'kysely';
import { normalizeQueryParams, toRequestString } from '../utils/request-values.js';
import { ofetch, type $Fetch } from 'ofetch';
import { cache, db, isSqlite } from '../utils/database.js';
import { Metadata } from '../dto/Metadata.entity.js';
import { Hub } from '../dto/Hub.entity.js';
import { PMSService } from '../plex/plex.service.js';
import { Cron, CronExpression } from '@nestjs/schedule';
import { StremioService } from '../stremio/stremio.service.js';
import type { StremioService as StremioServiceType } from '../stremio/stremio.service.js';
import { StremioMeta } from '../stremio/stremio.js';
import { ScrobblingService } from '../scrobbling/scrobbling.service.js';
import { ClientType } from '../middleware/client-identifier.middleware.js';
import { emptyMedia } from '../utils/plex.js';

@Injectable()
export class MetadataService {

	constructor (private pmsService: PMSService, @Inject(forwardRef(() => StremioService)) private stremioService: StremioServiceType, private scrobblingService: ScrobblingService) {}

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
				'X-Plex-Token': toRequestString((options.query as any)?.['X-Plex-Token']) ?? this.pmsService.plexToken,
				// 'X-Plex-Provider-Version': '7.2',
				// 'X-Plex-Text-Format': 'plain',
				// 'X-Plex-Drm': 'widevine',
				// 'X-Plex-Language': 'en',
			};
		},
	});

	/**
	 * Hydrates metadata items in-place for a specific user and returns the same array.
	 *
	 * - Movies and episodes get their `Media` populated from the local Plex server via a single
	 *   batched `resolveLocalItem` fetch (items without a local mapping keep their existing value).
	 * - All items get their user state applied from `getUserState` (Plex state merged with the
	 *   local `progress` table, local taking precedence): episodes/movies receive `viewOffset`,
	 *   `viewCount`, `lastViewedAt` and `userState`, while shows/seasons receive `viewedLeafCount`
	 *   and have their `leafCount` reduced by it, clamped at zero.
	 *
	 * Requires an authenticated user (`user.id`) for the progress portions; without one only
	 * `Media` hydration runs. Pass the active request's `plexToken` so the remote user state is
	 * fetched as the requesting user rather than the server's own account.
	 */
	async hydrateMetadata (metadata: Metadata[], user: MyPlexUser, plexToken?: string): Promise<Metadata[]> {
		if (!metadata.length) return metadata;

		//Populate Media using a single batched metadata fetch.
		const mediaItems = metadata.filter((item) => item.type === 'movie' || item.type === 'episode');
		const localItems = await this.pmsService.resolveLocalItem(mediaItems);

		for (const [i, item] of mediaItems.entries()) {
			const localItem = localItems[i];
			if (localItem?.Media?.[0]) item.Media = [localItem.Media[0]];
		}

		if (!user?.id) return metadata;


		const UserState = await this.scrobblingService.getState(metadata, user);
		
		const stateByRatingKey = new Map(UserState.map((state) => [state.ratingKey, state]));

		for (const item of metadata) {
			item.userState = true;

			const state = item.ratingKey ? stateByRatingKey.get(item.ratingKey.split('/').pop()) : undefined;
			if (!state) continue;

			item.viewOffset = state.viewOffset ?? undefined;
			item.viewCount = state.viewCount ?? 0;
			item.lastViewedAt = state.lastViewedAt ?? undefined;

			if (state.viewedLeafCount) {
				item.viewedLeafCount = state.viewedLeafCount;
			}
		}

		return metadata;
	}

	/**
	 * Builds the Continue Watching shelf for a user from the last four weeks of `progress` rows.
	 *
	 * Grouping happens in the query: rows are grouped by show (`grandparent_guid`, or a season row's
	 * `parent_guid`, falling back to the item's own `guid` for movies) and reduced to the most
	 * recently aired entry of each group, so a show ever yields at most one shelf item. A `view_count`
	 * of `-1` is a hide marker placed on the group's key row by `removeFromContinueWatching`; any
	 * later progress update (timeline, scrobble or unscrobble) deletes it and returns the show to the
	 * shelf. A group stays hidden only while its newest activity is no newer than the marker. The
	 * ranking and recency expressions are written so the query runs unchanged on SQLite and Postgres:
	 * `row_number() over (partition by …)` (SQLite ≥ 3.25) and `coalesce(…, -1)` sentinels, which
	 * keep nulls out of the ordering entirely so the two engines' opposite null-ordering defaults
	 * never come into play.
	 *
	 * Finished items continue from the highest watched index: the shelf walks the show's seasons in
	 * order from the last watched one and returns the first candidate after it that is neither
	 * watched (per the group's own rows) nor unaired; a finished season starts at the next season.
	 * Items with nothing left to play are omitted. In-progress items
	 * resolve directly to their own metadata. User state (`viewOffset`, `viewCount`,
	 * `lastViewedAt`) and `Media` are applied by `hydrateMetadata`, after which results are sorted
	 * by most recently viewed.
	 */
	async getContinueWatching(user: MyPlexUser, plexToken?: string): Promise<Metadata[]> {
		if (!user?.id) return [];

		const fourWeeksAgo = Math.floor(Date.now() / 1000) - 4 * 7 * 24 * 60 * 60;

		//`max(a, b)` is SQLite's scalar maximum; Postgres spells it `greatest`. Both ignore nulls and
		//only return null when every argument is null, so the null-safe `-1`/`0` sentinels below mean the
		//differing null-ordering defaults never affect ranking. Everything else in the query is identical SQL.
		const scalarMax = isSqlite ? 'max' : 'greatest';

		type ContinueWatchingRow = {
			guid: string;
			view_offset: number | null;
			view_count: number | null;
			created_at: number | null;
			updated_at: number | null;
		};

		//-1 sentinels keep null indexes out of the ranking. The rank columns mirror the old `score` helper:
		//a season's own row is ranked at its own season with no episode, so it can't mask newer episodes.
		const rows: ContinueWatchingRow[] = (
			await sql<ContinueWatchingRow>`
				with scoped as (
					select
						guid,
						view_offset,
						view_count,
						created_at,
						updated_at,
						coalesce(
							grandparent_guid,
							case when guid like 'plex://season/%' then parent_guid end,
							guid
						) as group_key,
						${sql.raw(scalarMax)}(coalesce(updated_at, 0), coalesce(created_at, 0)) as recency,
						--"index" is reserved in SQLite, so it is double-quoted here; both engines treat that as identifier quoting.
						case
							when grandparent_guid is null and parent_guid is not null and guid like 'plex://season/%'
								then coalesce("index", -1)
							else coalesce(parent_index, -1)
						end as rank_season,
						case
							when grandparent_guid is null and parent_guid is not null and guid like 'plex://season/%'
								then -1
							else coalesce("index", -1)
						end as rank_episode
					from progress
					where account_id = ${user.id}
						and (created_at >= ${fourWeeksAgo} or updated_at >= ${fourWeeksAgo})
				),
				--A view_count of -1 on a group's key row hides the group until real activity is strictly newer.
				stats as (
					select
						group_key,
						max(case when view_count = -1 then coalesce(updated_at, 0) end) as hidden_at,
						max(case when coalesce(view_count, 0) <> -1 then ${sql.raw(scalarMax)}(coalesce(updated_at, 0), coalesce(created_at, 0)) end) as activity_at
					from scoped
					group by group_key
				),
				ranked as (
					select
						scoped.*,
						row_number() over (
							partition by scoped.group_key
							order by scoped.rank_season desc, scoped.rank_episode desc
						) as rn
					from scoped
					where coalesce(scoped.view_count, 0) <> -1
				)
				select ranked.guid, ranked.view_offset, ranked.view_count, ranked.created_at, ranked.updated_at
				from ranked
				join stats on stats.group_key = ranked.group_key
				where ranked.rn = 1
					and (stats.hidden_at is null or stats.hidden_at < stats.activity_at)
				order by ranked.recency desc
				limit 10
			`.execute(db)
		).rows;

		const entries = await Promise.all(
			rows
				.map(async (row) => {
					const plexItem = await this.getItem(row?.guid?.split('/')?.pop() as string)

					// console.log(plexItem);

					let item: Metadata | null | undefined;
					if (plexItem?.type === 'season' || plexItem?.type === 'episode') {
						if ((row.view_offset as number) > 0) item = plexItem;
						else if ((row.view_count as number) > 0 || plexItem.type === 'season') {
							//Finished rows continue from the first still-playable entry after the
							//anchor; the show row supplies the watched cascade when it exists. A
							//season row at zero is the unwatched override under a watched show and
							//resolves to that season's first still-playable episode.
							const showId = plexItem.grandparentGuid ?? (plexItem.type === 'season' ? plexItem.parentGuid : undefined);
							const show = showId ? await this.getItem(showId.split('/').pop()!) : null;
							item = await this.getNextEpisode(plexItem, show, user);
						} else {
							//An unwatched episode override under a watched parent: this episode is
							//the next thing to watch, so the shelf points straight at it.
							item = plexItem;
						}
					} else {
						//Shows and movies: a watched container row means everything under it was
						//cascaded away (or, for a movie, the scrobble reset the offset), so there is
						//nothing left to resume and the shelf item is hidden unless playback is mid-way.
						item = (row.view_offset ?? 0) > 0 ? plexItem : null;
					}

					return item ? { item: item, row } : null;
				}),
		);

		// const entries: any[] = [];

		const resolved = entries.filter((entry): entry is { item: Metadata; row: (typeof rows)[number] } => !!entry);

		await this.hydrateMetadata(resolved.map(({ item }) => item), user, plexToken);

		return resolved
			.map(({ item, row }) => {
				//The shelf only plays episodes and movies; rows attributed to a show/season guid
				//resolve to container metadata and are dropped.
				// if (item.type !== 'episode' && item.type !== 'movie') return null;

				if (item.lastViewedAt === undefined) {
					item.lastViewedAt = Math.max(item.addedAt ?? 0, row.created_at ?? 0, row.updated_at ?? 0);
				}

				//Skip items that haven't aired yet.
				if (item.originallyAvailableAt && new Date(item.originallyAvailableAt.replaceAll('-', '/')) > new Date()) return null;

				return item;
			})
			.filter((item): item is Metadata => !!item)
			.sort((a, b) => (b.lastViewedAt ?? 0) - (a.lastViewedAt ?? 0));
	}

	/**
	 * Resolves the episode a finished shelf row continues to: the first entry after the given
	 * season/episode anchor, in season-then-episode order, that the user can still watch. An
	 * episode is playable unless it is watched (by its own row or cascaded from a watched
	 * season/show, honouring explicit unwatched overrides) or has not aired yet; seasons are
	 * skipped entirely when watched. Watch state comes from the group's own `progress` rows, so a
	 * season re-marked watched after a show-level "watched" no longer surfaces its cascaded successor.
	 * Returns null when the season/show has nothing left to play, hiding the shelf item.
	 */
	async getNextEpisode (item: Metadata, show: Metadata | null, user: MyPlexUser): Promise<Metadata | null> {
		if (item.type !== 'season' && item.type !== 'episode') return null;
		if (!user?.id) return null;

		const showGuid = show?.guid ?? item.grandparentGuid ?? (item.type === 'season' ? item.parentGuid : undefined);

		//Watched-state rows for the whole show group in one query: episode rows by show, season
		//rows by their `parent_guid`, plus the show's own row for the watched cascade.
		const rows = await db
			.selectFrom('progress')
			.select(['guid', 'view_count'])
			.where('account_id', '=', user.id)
			.where((eb) =>
				showGuid
					? eb.or([eb('grandparent_guid', '=', showGuid), eb('parent_guid', '=', showGuid), eb('guid', '=', showGuid)])
					: eb.or([eb('guid', '=', item.parentGuid ?? ''), eb('guid', '=', item.guid ?? '')]),
			)
			.execute();

		//-1 is the Continue Watching hide marker, not a watched state.
		const stateByGuid = new Map(
			rows.filter((row) => row.view_count !== -1).map((row) => [row.guid, row] as const),
		);
		const getEntry = (guid?: string) => (guid ? stateByGuid.get(guid) : undefined);
		const isWatched = (guid?: string) => (getEntry(guid)?.view_count ?? 0) > 0;
		const isUnwatchedOverride = (guid?: string) => !!getEntry(guid) && (getEntry(guid)?.view_count ?? 0) <= 0;

		const isWatchedByCascade = (ep: Metadata): boolean => {
			if (isUnwatchedOverride(ep.guid)) return false;
			if (isWatched(ep.guid)) return true;
			if (isUnwatchedOverride(ep.parentGuid)) return false;
			return isWatched(ep.parentGuid) || isWatched(showGuid);
		};
		const isSeasonWatched = (season: Metadata): boolean => {
			if (isUnwatchedOverride(season.guid)) return false;
			return isWatched(season.guid) || isWatched(showGuid);
		};
		const hasAired = (ep: Metadata) =>
			!ep.originallyAvailableAt || new Date(ep.originallyAvailableAt.replaceAll('-', '/')) <= new Date();

		const playableIn = async (seasonId: string): Promise<Metadata | null> => {
			const episodes = await this.getItemChildren(seasonId, 200);
			return episodes?.find((ep) => !isWatchedByCascade(ep) && hasAired(ep)) ?? null;
		};

		if (item.type === 'season') {
			if (!isSeasonWatched(item)) {
				const first = await playableIn(item.ratingKey.split('/').pop()!);
				if (first) return first;
			}
			const nextSeason = await this.getNextSeason(item);
			if (!nextSeason || isSeasonWatched(nextSeason)) return null;
			return playableIn(nextSeason.ratingKey.split('/').pop()!);
		}

		//Stay inside the anchor's own season: first still-playable episode after its index.
		const episodes = await this.getItemChildren((item.parentRatingKey ?? item.parentGuid)?.split('/').pop()!, 200, 0);
		const later = episodes?.filter((ep) => (ep.index ?? 0) > (item.index ?? 0)) ?? [];
		const inSeason = later.find((ep) => !isWatchedByCascade(ep) && hasAired(ep));
		if (inSeason) return inSeason;

		const nextSeason = await this.getNextSeason(item);
		if (!nextSeason || isSeasonWatched(nextSeason)) return null;
		return playableIn(nextSeason.ratingKey.split('/').pop()!);
	}

	async getNextSeason (item: Metadata): Promise<Metadata | undefined> {
		let seasons = await this.getItemChildren(item.type === 'season' ? item.parentRatingKey : item.grandparentRatingKey, 100, 0);
		if (!seasons) return undefined;
		//Episodes carry their episode index, so season lookup from an episode goes through its season.
		if (item.type === 'episode') {
			const season = await this.getItem((item.parentGuid ?? item.parentRatingKey)?.split('/').pop()!);
			if (!season) return undefined;
			seasons = await this.getItemChildren(season.parentRatingKey?.split('/').pop() ?? season.parentGuid?.split('/').pop()!, 100, 0);
			if (!seasons) return undefined;
			return seasons.find((s) => s.index === (season.index ?? -1) + 1);
		}
		let nextSeason = seasons.find((s) => s.index === (item.index ?? -1) + 1);
		return nextSeason;
	}


	/**
	 * Hides an item from Continue Watching, mirroring Plex's `/actions/removeFromContinueWatching`.
	 *
	 * Writes a `view_offset` of `-1` marker on the row Continue Watching groups the item under:
	 * the show itself for episodes (via `grandparentRatingKey`), otherwise the item's own row. For
	 * a movie that also clears its playback position. Episode-level progress is left untouched, so
	 * the show reappears on the shelf the next time one of its episodes is played.
	 */
	async removeFromContinueWatching(ratingKey: string, user: MyPlexUser): Promise<void> {
		if (!user?.id || !ratingKey) return;

		const item = await this.getItem(ratingKey.split('/').pop()!);
		if (!item) throw new NotFoundException(`Unable to find metadata for ${ratingKey}`);

		//The shelf's group key is the show for episodes, otherwise the item itself.
		const groupRatingKey = item.grandparentRatingKey ?? (item.type === 'season' ? item.parentRatingKey : undefined) ?? item.ratingKey;
		const targetId = groupRatingKey.split('/').pop()!;
		const target = targetId === item.ratingKey.split('/').pop() ? item : await this.getItem(targetId);
		if (!target?.guid) throw new NotFoundException(`Unable to find metadata for ${targetId}`);

		const now = Math.floor(Date.now() / 1000);

		await db
			.insertInto('progress')
			.values({
				account_id: user.id,
				guid: target.guid,
				parent_guid: target.parentGuid,
				grandparent_guid: target.grandparentGuid,
				index: null,
				parent_index: null,
				view_count: -1,
				view_offset: 0,
				last_viewed_at: null,
				updated_at: now,
			})
			.onConflict((oc) =>
				oc
					.columns(['account_id', 'guid'])
					.doUpdateSet({
						grandparent_guid: target.type === 'show' ? target.guid : null,
						index: null,
						parent_index: null,
						view_count: -1,
						view_offset: 0,
						last_viewed_at: null,
						updated_at: now,
					}),
			)
			.execute();
	}

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
					resolved.push(await this.resolvePlexItemFromStremioMeta(meta));
				} catch (e) {
					console.error(e);
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

	async resolvePlexItemFromStremioMeta(stremioMeta: StremioMeta): Promise<Metadata | null> {
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

		await this.upsertMetadataEntry({
			id: plexId,
			imdbId: imdbGuid ?? null,
			tmdbId: tmdbGuid ?? null,
			tvdbId: tvdbGuid ?? null,
			data: item,
		});

		return item;
	}
	

	private async upsertMetadataEntry(params: {
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

					await this.upsertMetadataEntry({
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

	applyDummyMedia (metadata: Metadata, clientType: ClientType) {
		const Media = metadata.Media?.[0];
		switch (clientType) {
			case ClientType.NATIVE_ANDROID:
			case ClientType.NATIVE_APPLE:
				metadata.Media = Media ? [Media] : [emptyMedia() as any]
				break;
			case ClientType.REACT_NATIVE:
			case ClientType.ROKU:
				metadata.Media = Media ? [Media] : undefined
			case ClientType.WEB:
			case ClientType.BIGSCREEN:
			default:
				metadata.Media = Media ? [Media] : []
				break;
		}
	}
}
