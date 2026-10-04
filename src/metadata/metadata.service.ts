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

		//Progress and watched leaf counts come from the merged Plex/local user state.
		const ratingKeys = [...new Set(
			metadata
				.map((item) => item.ratingKey?.split('/').pop())
				.filter((ratingKey): ratingKey is string => !!ratingKey),
		)];

		if (!ratingKeys.length) return metadata;

		const { UserState } = await this.getUserState(ratingKeys.join(','), user, plexToken);

		const stateByRatingKey = new Map(UserState.map((state) => [state.ratingKey, state]));

		for (const item of metadata) {
			const state = item.ratingKey ? stateByRatingKey.get(item.ratingKey.split('/').pop()) : undefined;
			if (!state) continue;

			item.viewOffset = state.viewOffset ?? undefined;
			item.viewCount = state.viewCount ?? 0;
			item.lastViewedAt = state.lastViewedAt ?? undefined;
			item.userState = true;

			if (state.viewedLeafCount) {
				item.viewedLeafCount = state.viewedLeafCount;
			}
		}

		return metadata;
	}

	/**
	 * Builds the Continue Watching shelf for a user from the last four weeks of `progress` rows.
	 *
	 * Rows are grouped by show (`grandparent_guid`, falling back to the item's own `guid` for
	 * movies) and reduced to the most recently aired entry of each group. A `view_offset` of `-1`
	 * is a hide marker placed on the group's key row by `removeFromContinueWatching`; any later
	 * progress update (timeline, scrobble or unscrobble) deletes it and returns the show to the
	 * shelf. A group stays hidden only while its newest activity is no newer than the marker.
	 *
	 * Finished items advance to the next available episode (same season, otherwise the next
	 * season's first episode); items with nothing left to play are omitted. In-progress items
	 * resolve directly to their own metadata. User state (`viewOffset`, `viewCount`,
	 * `lastViewedAt`) and `Media` are applied by `hydrateMetadata`, after which results are sorted
	 * by most recently viewed.
	 */
	async getContinueWatching(user: MyPlexUser, plexToken?: string): Promise<Metadata[]> {
		if (!user?.id) return [];

		const fourWeeksAgo = Math.floor(Date.now() / 1000) - 4 * 7 * 24 * 60 * 60;

		const rows = await db
			.selectFrom('progress')
			.select(['guid', 'grandparent_guid', 'index', 'parent_index', 'view_offset', 'view_count', 'created_at', 'updated_at'])
			.where('account_id', '=', user.id)
			.where((eb) => eb.or([eb('created_at', '>=', fourWeeksAgo), eb('updated_at', '>=', fourWeeksAgo)]))
			.execute();

		const groupKeyOf = (row: (typeof rows)[number]) => row.grandparent_guid ?? row.guid;
		const isHideMarker = (row: (typeof rows)[number]) => row.view_count === -1;

		//A -1 marker row on a show's (or movie's) own guid hides the group until something newer is watched.
		const hiddenAt = new Map<string, number>();
		const newestActivity = new Map<string, number>();
		for (const row of rows) {
			const groupKey = groupKeyOf(row);
			if (!groupKey) continue;

			if (isHideMarker(row)) {
				hiddenAt.set(groupKey, Math.max(hiddenAt.get(groupKey) ?? 0, row.updated_at ?? 0));
			} else {
				newestActivity.set(groupKey, Math.max(newestActivity.get(groupKey) ?? 0, row.updated_at ?? 0, row.created_at ?? 0));
			}
		}

		//Keep the most recently aired entry of each show, i.e. the newest season/episode.
		const groups = new Map<string, (typeof rows)[number]>();
		for (const row of rows) {
			if (isHideMarker(row)) continue;

			const groupKey = groupKeyOf(row);
			if (!groupKey) continue;

			const hidden = hiddenAt.get(groupKey);
			if (hidden !== undefined && hidden >= (newestActivity.get(groupKey) ?? 0)) continue;

			const current = groups.get(groupKey);
			const score = (entry: (typeof rows)[number]) => [entry.parent_index ?? -1, entry.index ?? -1];

			const [rowSeason, rowEpisode] = score(row);
			const [currentSeason, currentEpisode] = current ? score(current) : [-1, -1];

			if (!current || rowSeason > currentSeason || (rowSeason === currentSeason && rowEpisode > currentEpisode)) {
				groups.set(groupKey, row);
			}
		}

		const entries = await Promise.all(
			[...groups.values()]
				.sort((a, b) => Math.max(b.updated_at ?? 0, b.created_at ?? 0) - Math.max(a.updated_at ?? 0, a.created_at ?? 0))
				.map(async (row) => {
					const completed = (row.view_count ?? 0) > 0;
					const showId = row.grandparent_guid?.split('/').pop();

					let item: Metadata | null;
					if (completed) {
						//Finished items roll forward to the next unwatched episode.
						item =
							row.parent_index !== null && showId
								? ((await this.getEpisodeByIndex(showId, row.parent_index, (row.index ?? 0) + 1)) ??
									(await this.getEpisodeByIndex(showId, row.parent_index + 1, 1)))
								: null;
					} else {
						item = await this.getItem(row.guid.split('/').pop()!);
					}

					return item ? { item, row } : null;
				}),
		);

		const resolved = entries.filter((entry): entry is { item: Metadata; row: (typeof rows)[number] } => !!entry);

		await this.hydrateMetadata(resolved.map(({ item }) => item), user, plexToken);

		return resolved
			.map(({ item, row }) => {
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
				grandparent_guid: target.type === 'show' ? target.guid : null,
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

	/**
	 * Resolves an episode by show id plus season/episode numbers. Episodes are the season's leaf
	 * children, so the season lookup can exclude leaves while the episode lookup must not.
	 */
	private async getEpisodeByIndex(showId: string, season: number, index: number): Promise<Metadata | null> {
		try {
			const seasons = await this.getItemChildren(showId);
			const seasonId = seasons?.find((item) => item.type === 'season' && item.index === season)?.ratingKey?.split('/').pop();
			if (!seasonId) return null;

			const episodes = (
				await this.discoverApi<{ MediaContainer?: { Metadata?: Metadata[] } }>(`/library/metadata/${seasonId}/children`, {
					query: { 'X-Plex-Container-Size': 500 },
				})
			)?.MediaContainer?.Metadata ?? [];

			return episodes.find((episode) => episode.index === index) ?? null;
		} catch {
			return null;
		}
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
	
	/**
	 * Records playback state for an item in the local `progress` table, upserting on its
	 * (`account_id`, `guid`) unique constraint.
	 *
	 * - `scrobble` increments `view_count` and stamps `last_viewed_at`, resetting `view_offset`
	 *   since a scrobble only happens at the end of an item.
	 * - `unscrobble` clears `view_count` and `last_viewed_at`.
	 * - `timeline` stores the current `viewOffset` (milliseconds) and stamps `last_viewed_at`,
	 *   leaving `view_count` alone on update and at `0` when the row does not exist yet.
	 *
	 * The show/season identifiers are taken from the item so watched leaves stay attributable to
	 * the right show (`grandparent_guid`) and season (`parent_index`) for `viewedLeafCount`.
	 */
	async updateProgress(
		item: Metadata,
		user: MyPlexUser,
		update: { type: 'scrobble' } | { type: 'unscrobble' } | { type: 'timeline'; viewOffset: number } = { type: 'scrobble' },
	): Promise<void> {
		const guid = item?.guid;
		if (!user?.id || !guid) return;

		const now = Math.floor(Date.now() / 1000);
		const isTimeline = update.type === 'timeline';
		const scrobble = update.type === 'scrobble';

		await db
			.insertInto('progress')
			.values({
				account_id: user.id,
				guid,
				grandparent_guid: item.grandparentGuid ?? null,
				index: item.index ?? null,
				parent_index: item.parentIndex ?? null,
				view_count: isTimeline ? 0 : scrobble ? 1 : 0,
				view_offset: isTimeline ? update.viewOffset : 0,
				last_viewed_at: scrobble || isTimeline ? now : null,
				updated_at: now,
			})
			.onConflict((oc) =>
				oc
					.columns(['account_id', 'guid'])
					.doUpdateSet({
						grandparent_guid: item.grandparentGuid ?? null,
						index: item.index ?? null,
						parent_index: item.parentIndex ?? null,
						...(isTimeline ? {} : { view_count: scrobble ? sql<number>`view_count + 1` : 0 }),
						view_offset: isTimeline ? update.viewOffset : 0,
						last_viewed_at: scrobble || isTimeline ? now : null,
						updated_at: now,
					}),
			)
			.execute();

		//Playing any episode clears the show's Continue Watching hide marker; the item's own row is
		//already overwritten by the upsert above.
		const showGuid = item.grandparentGuid ?? (item.type === 'season' ? item.parentGuid : undefined);
		if (showGuid && showGuid !== guid) {
			await db
				.deleteFrom('progress')
				.where('account_id', '=', user.id)
				.where('guid', '=', showGuid)
				.where('view_count', '=', -1)
				.execute();
		}
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

	/**
	 * Fetches user state for comma separated rating keys from the Discover API and merges it with
	 * the local `progress` table. Local state takes precedence over Plex's, except when Plex's
	 * `lastViewedAt` is newer, in which case the remote state wins.
	 *
	 * For shows and seasons, a `viewedLeafCount` is computed from the watched leaves (progress
	 * rows with `view_count > 0` plus remotely completed leaves) merged and deduplicated by guid.
	 * Show counts match on `grandparent_guid`; season counts additionally match `parent_index`
	 * against the season's `index`. Remote `viewedLeafCount` values are honored via `Math.max`.
	 *
	 * `plexToken` should be the active request's token so the remote state belongs to the
	 * requesting user; it falls back to the server's own token when omitted.
	 */
	async getUserState(ids: string, user: MyPlexUser, plexToken?: string): Promise<{ UserState: PlexUserState[] }> {
		const ratingKeys = ids.split(',').filter((id) => !!id);

		if (!ratingKeys.length) return { UserState: [] };

		const remoteStates: PlexUserState[] =
			(
				await this.discoverApi<{ MediaContainer?: { UserState?: PlexUserState[] } }>(
					`/library/metadata/${encodeURIComponent(ids)}/userState`,
					{ query: plexToken ? { 'X-Plex-Token': plexToken } : undefined },
				)
			)?.MediaContainer?.UserState ?? [];

		const remoteByRatingKey = new Map<string | undefined, PlexUserState>(remoteStates.map((state) => [state.ratingKey, state]));

		const dataById = new Map<string, any>(
			(
				await db
					.selectFrom('metadata')
					.select(['id', 'data'])
					.where('id', 'in', ratingKeys)
					.execute()
			)
				.map((record) => [record.id, typeof record.data === 'string' ? JSON.parse(record.data) : record.data] as const),
		);

		const guidToRatingKey = new Map<string, string>();

		for (const [id, data] of dataById) {
			if (data?.guid) guidToRatingKey.set(data.guid, id);
		}

		const leafGuids = [...guidToRatingKey.keys()];

		//Watched episode counts for shows/seasons need every progress row under the shows in play.
		const containerShowGuids = [...new Set(
			[...dataById.values()]
				.filter((data) => data?.type === 'show' || data?.type === 'season')
				.map((data) => (data.type === 'show' ? data.guid : data.parentGuid) as string)
				.filter((guid): guid is string => !!guid),
		)];

		const watchedLeaves = new Map<string, { grandparentGuid?: string | null; parentIndex?: number | null }>();
		const localByRatingKey = new Map<string | undefined, PlexUserState>();

		if (user?.id && (leafGuids.length || containerShowGuids.length)) {
			const rows = await db
				.selectFrom('progress')
				.select(['guid', 'grandparent_guid', 'parent_index', 'view_count', 'view_offset', 'last_viewed_at'])
				.where('account_id', '=', user.id)
				.where((eb) =>
					leafGuids.length && containerShowGuids.length
						? eb.or([eb('guid', 'in', leafGuids), eb('grandparent_guid', 'in', containerShowGuids)])
						: leafGuids.length
							? eb('guid', 'in', leafGuids)
							: eb('grandparent_guid', 'in', containerShowGuids),
				)
				.execute();

			for (const row of rows) {
				if ((row.view_count ?? 0) > 0) {
					watchedLeaves.set(row.guid, { grandparentGuid: row.grandparent_guid, parentIndex: row.parent_index });
				}

				const ratingKey = guidToRatingKey.get(row.guid);
				if (!ratingKey) continue;

				localByRatingKey.set(ratingKey, {
					ratingKey,
					viewCount: row.view_count ?? 0,
					viewOffset: row.view_offset ?? 0,
					lastViewedAt: row.last_viewed_at ?? undefined,
					viewState: (row.view_count ?? 0) > 0 ? 'complete' : undefined,
				});
			}
		}

		//Remotely completed leaves count as watched even without local progress rows.
		for (const state of remoteStates) {
			if (!state.ratingKey || !((state.viewCount ?? 0) > 0 || state.viewState === 'complete')) continue;

			const data = dataById.get(state.ratingKey);
			if (!data?.guid || watchedLeaves.has(data.guid)) continue;

			watchedLeaves.set(data.guid, { grandparentGuid: data.grandparentGuid, parentIndex: data.parentIndex });
		}

		const watchedByShow = new Map<string, { total: number; bySeason: Map<number, number> }>();

		for (const leaf of watchedLeaves.values()) {
			if (!leaf.grandparentGuid) continue;

			let entry = watchedByShow.get(leaf.grandparentGuid);
			if (!entry) watchedByShow.set(leaf.grandparentGuid, (entry = { total: 0, bySeason: new Map() }));

			entry.total++;
			if (leaf.parentIndex !== undefined && leaf.parentIndex !== null) {
				entry.bySeason.set(leaf.parentIndex, (entry.bySeason.get(leaf.parentIndex) ?? 0) + 1);
			}
		}

		//Attach computed viewedLeafCount to show/season entries, keeping any larger remote count.
		for (const [id, data] of dataById) {
			if (data?.type !== 'show' && data?.type !== 'season') continue;

			const showGuid = data.type === 'show' ? data.guid : data.parentGuid;
			const counts = showGuid ? watchedByShow.get(showGuid) : undefined;
			const computed = data.type === 'show'
				? counts?.total ?? 0
				: data.index !== undefined && data.index !== null
					? counts?.bySeason.get(data.index) ?? 0
					: 0;

			const remoteCount = remoteByRatingKey.get(id)?.viewedLeafCount;
			const viewedLeafCount = Math.max(computed, remoteCount ?? 0);

			if (!viewedLeafCount) continue;

			localByRatingKey.set(id, { ...localByRatingKey.get(id), ratingKey: id, viewedLeafCount });
		}

		const UserState = [
			...new Set([...remoteByRatingKey.keys(), ...localByRatingKey.keys()]),
		]
			.map((ratingKey) => {
				const remote = remoteByRatingKey.get(ratingKey);
				const local = localByRatingKey.get(ratingKey);

				if (!remote || !local) return remote ?? local ?? null;

				//Local progress wins unless Plex has something more recent.
				const merged = (remote.lastViewedAt ?? 0) > (local.lastViewedAt ?? 0)
					? { ...local, ...remote }
					: { ...remote, ...local };

				//Already the larger of the locally computed and remote leaf counts.
				return { ...merged, viewedLeafCount: local.viewedLeafCount ?? remote.viewedLeafCount };
			})
			.filter((state): state is PlexUserState => !!state);

		return { UserState };
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
}
