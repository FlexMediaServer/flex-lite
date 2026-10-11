import { forwardRef, Inject, Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { sql } from 'kysely';
import { ofetch } from 'ofetch';
import { PMSService } from '../plex/plex.service.js';
import { decryptPlexToken } from '../utils/crypto.js';
import { db } from '../utils/database.js';
import { Metadata } from '../dto/Metadata.entity.js';
import { claimPlaybackWatched, playbackWatched } from '../status/playback-sessions.js';
import { reachedPlayedThreshold } from '../plex/played-threshold.js';
import { MetadataService } from '../metadata/metadata.service.js';
import type { MetadataService as MetadataServiceType } from '../metadata/metadata.service.js';

const SERVICES_URL = 'https://plex.tv/api/v2/server/users/services';
const SCROBBLE_HOST = 'https://scrobbles.plex.tv';

const SERVICES_TTL = 10 * 60 * 1000; // ms
const TOKEN_SKEW = 30 * 1000; // ms
const SYNC_PAGE_SIZE = 50;

/** Decodes the `exp` claim (seconds) from a JWT without verifying the signature. */
function decodeJwtExpiry(token: string): number | undefined {
	const parts = token.split('.');
	if (parts.length !== 3) return undefined;

	try {
		const payload = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
		return typeof payload?.exp === 'number' ? payload.exp : undefined;
	} catch {
		return undefined;
	}
}

@Injectable()
export class ScrobblingService implements OnApplicationBootstrap {
	private readonly logger = new Logger(ScrobblingService.name);

	private services?: ServerUserServices[];
	private servicesExpiresAt = 0;
	private servicesFetch?: Promise<ServerUserServices[]>;

	private tokens = new Map<number, ScrobbleAccess>();
	private syncing = new Map<number, Promise<void>>();

	constructor(private pmsService: PMSService, @Inject(forwardRef(() => MetadataService)) private metadataService: MetadataServiceType) {}

	/** The feature is optional: it requires the decryption seed and a server token. */
	get enabled(): boolean {
		return !!process.env.PLEX_SERVICE_TOKEN_SEED && !!this.pmsService.plexToken;
	}

	/** Runs the first sync right after boot so state is fresh before the first cron tick. */
	onApplicationBootstrap(): void {
		// void this.syncAllUsers();
	}

	//A playback counts an item once, whether the client scrobbles it or Flex reaches the played threshold
	async scrobble(item: Metadata, user: MyPlexUser, playbackSessionId?: string) {
		if (playbackSessionId && item.guid && !claimPlaybackWatched(playbackSessionId, item.guid)) return;

		await this.updateState(item, user, { type: 'scrobble' })
	}

	async unscrobble(item: Metadata, user: MyPlexUser) {
		await this.updateState(item, user, { type: 'unscrobble' })
	}

	//Once the played threshold is reached the item is scrobbled, and the playback's offset is no longer tracked
	async timeline(item: Metadata, user: MyPlexUser, viewOffset: number, playbackSessionId?: string) {
		const guid = item.guid;
		if (playbackSessionId && guid && playbackWatched(playbackSessionId, guid)) return;

		if (playbackSessionId && guid && reachedPlayedThreshold(viewOffset, item.duration, await this.pmsService.playedThreshold())) {
			await this.scrobble(item, user, playbackSessionId);
			return;
		}

		await this.updateState(item, user, { type: 'timeline', viewOffset })
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
	 * Scrobbling or unscrobbling a season additionally clears its episodes' override rows, so the
	 * season's own state becomes the single source of truth for the cascade.
	 *
	 * Scrobbling or unscrobbling a show likewise clears every row beneath it, and unscrobbling a
	 * show drops its own row too, leaving no record behind rather than an empty one. A season
	 * keeps its own row, though: under a watched show it is the only thing able to mark just that
	 * season unwatched again.
	 *
	 * The show/season identifiers are taken from the item so watched leaves stay attributable to
	 * the right show (`grandparent_guid`) and season (`parent_index`) for `viewedLeafCount`.
	 */
	async updateState(
		item: Metadata,
		user: MyPlexUser,
		update: { type: 'scrobble' } | { type: 'unscrobble' } | { type: 'timeline'; viewOffset: number } = { type: 'scrobble' },
	): Promise<void> {
		const guid = item?.guid;
		if (!user?.id || !guid) return;

		//Items served the not found video are not really played, so their progress is never recorded
		if (await this.pmsService.isNotFoundItem(item)) return;

		const now = Math.floor(Date.now() / 1000);
		const isTimeline = update.type === 'timeline';
		const scrobble = update.type === 'scrobble';

		await db
			.insertInto('progress')
			.values({
				account_id: user.id,
				guid,
				parent_guid: item.parentGuid ?? null,
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

		//Unscrobbling a show removes its own row too, so no progress record is left behind; a
		//scrobble keeps it as the watched state the cascade flows from. Seasons never drop their
		//own row: beneath a watched show it is the only thing that can keep a season unwatched.
		const deleteOwnRow = update.type === 'unscrobble';

		if (item.type === 'show' && item.guid) {
			const showGuid = item.guid;
			//Season rows hang off the show via `parent_guid` (their `grandparent_guid` is null), so
			//both levels are cleared and the show's own row becomes the single source of truth.
			await db
				.deleteFrom('progress')
				.where('account_id', '=', user.id)
				.where((eb) =>
					eb.or([
						eb('grandparent_guid', '=', showGuid),
						eb('parent_guid', '=', showGuid),
						...(deleteOwnRow ? [eb('guid', '=', showGuid)] : []),
					]),
				)
				.execute();
		}

		//Marking a season watched/unwatched clears its episodes' rows (watched, override, -1 marker
		//and timeline rows alike) so stale per-episode state can't block the season's own state.
		if (item.type === 'season' && item.parentGuid && item.index !== undefined && item.index !== null) {
			const showGuid = item.parentGuid;
			const seasonIndex = item.index;
			await db
				.deleteFrom('progress')
				.where('account_id', '=', user.id)
				.where('grandparent_guid', '=', showGuid)
				.where('parent_index', '=', seasonIndex)
				.execute();
		}
	}

	private async getServices(force = false): Promise<ServerUserServices[]> {
		if (!force && this.services && Date.now() < this.servicesExpiresAt) return this.services;

		this.servicesFetch ??= ofetch<ServerUserServices[]>(SERVICES_URL, {
			headers: {
				Accept: 'application/json',
				'X-Plex-Provides': 'Server',
				'X-Plex-Token': this.pmsService.plexToken,
			},
			timeout: 30000,
		})
			.then((response) => {
				this.services = response ?? [];
				this.servicesExpiresAt = Date.now() + SERVICES_TTL;
				return this.services;
			})
			.finally(() => {
				this.servicesFetch = undefined;
			});

		return this.servicesFetch;
	}

	private async resolveAccess(userId: number, force = false): Promise<ScrobbleAccess | undefined> {
		const cached = this.tokens.get(userId);
		if (!force && cached && cached.expiresAt > Date.now() + TOKEN_SKEW) return cached;

		const users = await this.getServices(force);
		const service = users.find((user) => user.id === userId)?.services?.find((service) => service.identifier === 'scrobbling');

		//No scrobbling entry means the user has playback sync disabled on their profile.
		if (!service?.token) {
			this.tokens.delete(userId);
			return undefined;
		}

		const token = decryptPlexToken(service.token);
		const expiry = decodeJwtExpiry(token);
		const access: ScrobbleAccess = {
			token,
			endpoint: service.endpoint ?? SCROBBLE_HOST,
			expiresAt: expiry ? expiry * 1000 : Date.now() + SERVICES_TTL,
		};

		this.tokens.set(userId, access);
		return access;
	}

	/**
	 * Returns the decrypted scrobbling JWT for a user, transparently refetching the services
	 * endpoint once when the cached token's `exp` has lapsed. Returns `undefined` when the user
	 * has sync disabled (no `scrobbling` service entry).
	 */
	private async getScrobbleAccess(userId: number): Promise<ScrobbleAccess | undefined> {
		let access = await this.resolveAccess(userId);

		if (access && access.expiresAt <= Date.now() + TOKEN_SKEW) {
			access = await this.resolveAccess(userId, true);

			if (access && access.expiresAt <= Date.now() + TOKEN_SKEW) {
				this.logger.warn(`Scrobble token for user ${userId} is still expired after refetch`);
			}
		}

		return access;
	}

	/**
	 * Resolves playback state for a batch of metadata items purely from the local `progress`
	 * table.
	 *
	 * Watched status cascades down the hierarchy: a watched show marks its seasons watched and a
	 * watched show or season marks its episodes watched, without those children needing their own
	 * rows. An item's own row always wins: a watched row keeps it watched, while a
	 * `view_count <= 0` row forces it unwatched even under a watched ancestor. A `-1` view count
	 * is the Continue Watching hide marker and is treated as if no row existed.
	 *
	 * For shows and seasons, `viewedLeafCount` lets the client mark their episodes watched from
	 * the container's state alone: when the container resolves watched it is the item's
	 * `leafCount` minus the explicit unwatched episode overrides in the user's progress rows, and
	 * otherwise the number of watched episode rows under that show/season.
	 */
	async getState(items: Metadata[], user: MyPlexUser): Promise<PlexUserState[]> {
		if (!user?.id || !items.length) return [];

		const guids = [...new Set(
			items
				.flatMap((item) => [item.guid, item.parentGuid, item.grandparentGuid])
				.filter((guid): guid is string => !!guid),
		)];

		if (!guids.length) return [];

		//Containers need every leaf row of their show: overrides and watched counts live in the
		//progress table, not in `items` (a show/season page rarely carries its episodes).
		const containerShowGuids = [...new Set(
			items
				.map((item) => (item.type === 'show' ? item.guid : item.type === 'season' ? item.parentGuid : undefined))
				.filter((guid): guid is string => !!guid),
		)];

		const rows = await db
			.selectFrom('progress')
			.select(['guid', 'grandparent_guid', 'parent_index', 'view_count', 'view_offset', 'last_viewed_at'])
			.where('account_id', '=', user.id)
			.where((eb) =>
				containerShowGuids.length
					? eb.or([eb('guid', 'in', guids), eb('grandparent_guid', 'in', containerShowGuids)])
					: eb('guid', 'in', guids),
			)
			.execute();

		//-1 is the Continue Watching hide marker, not a watched state.
		const entries = new Map(rows.filter((row) => row.view_count !== -1).map((row) => [row.guid, row] as const));

		const getEntry = (guid?: string) => (guid ? entries.get(guid) : undefined);
		const isWatched = (guid?: string) => (getEntry(guid)?.view_count ?? 0) > 0;
		const isUnwatchedOverride = (guid?: string) => !!getEntry(guid) && (getEntry(guid)?.view_count ?? 0) <= 0;

		const resolvesWatched = (item: Metadata): boolean => {
			if (isUnwatchedOverride(item.guid)) return false;
			if (isWatched(item.guid)) return true;

			//Cascade: episodes inherit from their season or show, seasons from their show. An
			//explicitly unwatched season overrides a watched show, so its episodes can't inherit
			//watched from the show while the season's own unwatched row stands.
			if (item.type === 'episode') {
				if (isUnwatchedOverride(item.parentGuid)) return false;
				return isWatched(item.parentGuid) || isWatched(item.grandparentGuid);
			}
			if (item.type === 'season') return isWatched(item.parentGuid);

			return false;
		};

		//State is matched by the caller on the plain id, matching getUserState.
		const ratingKeyOf = (item: Metadata) => (item.ratingKey || item.key)?.split('/').pop();

		//Leaf statistics per container, built from every episode row under the shows in play.
		//Seasons are keyed by `<showGuid>#<seasonIndex>` since episode rows attribute via
		//`grandparent_guid` + `parent_index` rather than the season's guid.
		type LeafStats = { watched: number; unwatched: number };
		const seasonStats = new Map<string, LeafStats>();
		const showStats = new Map<string, LeafStats>();
		const addStat = (statsByGuid: Map<string, LeafStats>, key: string, watched: boolean) => {
			const stats = statsByGuid.get(key) ?? { watched: 0, unwatched: 0 };
			stats[watched ? 'watched' : 'unwatched']++;
			statsByGuid.set(key, stats);
		};

		const episodeByGuid = new Map(
			items.filter((item) => item.type === 'episode' && item.guid).map((item) => [item.guid as string, item] as const),
		);

		for (const row of entries.values()) {
			//Synced rows may lack show attribution; fall back to the episode's own metadata.
			const episode = episodeByGuid.get(row.guid);
			const showGuid = row.grandparent_guid ?? episode?.grandparentGuid;

			//Rows without a show (the show's and season's own rows) are not leaves.
			if (!showGuid) continue;

			const watched = (row.view_count ?? 0) > 0;
			addStat(showStats, showGuid, watched);

			const seasonIndex = row.parent_index ?? episode?.parentIndex;
			if (seasonIndex !== undefined && seasonIndex !== null) addStat(seasonStats, `${showGuid}#${seasonIndex}`, watched);
		}

		const states: PlexUserState[] = [];

		for (const item of items) {
			if (!item.guid) continue;

			const entry = getEntry(item.guid);

			if (item.type === 'show' || item.type === 'season') {
				const stats =
					item.type === 'season'
						? item.parentGuid && item.index !== undefined && item.index !== null
								? seasonStats.get(`${item.parentGuid}#${item.index}`)
								: undefined
						: showStats.get(item.guid);
				const watched = resolvesWatched(item);
				const viewedLeafCount = watched
					? Math.max((item.leafCount ?? ((stats?.watched ?? 0) + (stats?.unwatched ?? 0))) - (stats?.unwatched ?? 0), 0)
					: (stats?.watched ?? 0);

				if (!entry && !viewedLeafCount) continue;

				const state: PlexUserState = { ratingKey: ratingKeyOf(item) };

				if (entry) {
					state.viewCount = entry.view_count ?? 0;
					state.viewOffset = entry.view_offset ?? 0;
					state.lastViewedAt = entry.last_viewed_at ?? undefined;
					state.viewState = watched ? 'complete' : 'unplayed';
				}

				if (viewedLeafCount) state.viewedLeafCount = viewedLeafCount;

				states.push(state);
				continue;
			}

			//Episodes and movies report state when they have their own row or are watched via a parent.
			const watched = resolvesWatched(item);
			if (!entry && !watched) continue;

			states.push({
				ratingKey: ratingKeyOf(item),
				viewCount: watched ? Math.max(entry?.view_count ?? 1, 1) : (entry?.view_count ?? 0),
				viewOffset: entry?.view_offset ?? 0,
				lastViewedAt: entry?.last_viewed_at ?? undefined,
				viewState: watched ? 'complete' : 'unplayed',
			});
		}

		return states;
	}

	/**
	 * Pulls each user's remote scrobbled history into the local `progress` table on a timer, so
	 * user state can be served without per-user Discover calls. Ingestion is incremental: the last
	 * page key (`endCursor`) fetched is stored per user and each run resumes from it, paging until
	 * the end of the list. Failures are logged and never thrown.
	 */
	// @Cron(CronExpression.EVERY_10_MINUTES)
	async syncAllUsers(): Promise<void> {
		if (!this.enabled) return;

		let users: ServerUserServices[];
		try {
			users = await this.getServices();
		} catch (error) {
			this.logger.warn(`Scrobble sync aborted, services fetch failed: ${(error as Error)?.message ?? error}`);
			return;
		}

		for (const user of users) {
			if (!user.id || !user.services?.some((service) => service.identifier === 'scrobbling')) continue;
			await this.syncUser(user.id).catch((error) => {
				this.logger.warn(`State sync for user ${user.id} failed: ${(error as Error)?.message ?? error}`);
			});
		}
	}

	/** De-duplicates concurrent syncs for the same user. */
	async syncUser(userId: number): Promise<void> {
		const inFlight = this.syncing.get(userId);
		if (inFlight) return inFlight;

		const task = this.doSyncUser(userId).finally(() => this.syncing.delete(userId));
		this.syncing.set(userId, task);

		return task;
	}

	private async doSyncUser(userId: number): Promise<void> {
		const access = await this.getScrobbleAccess(userId);
		if (!access) return;

		//Resume from the page key stored for the user, paging forward until the end of the list.
		let after =
			(await db.selectFrom('scrobble_sync').select('cursor').where('account_id', '=', userId).executeTakeFirst())?.cursor ?? undefined;
		const now = Math.floor(Date.now() / 1000);

		let cursor = after;

		while (true) {
			const response = await ofetch<PlexScrobbleStateResponse>(`${access.endpoint}/state/${userId}`, {
				query: { count: 100, ...(cursor ? { after: cursor } : {}) },
				headers: {
					// Accept: 'application/json',
					Authorization: `Bearer ${access.token}`,
					Accept: 'application/json',
					'X-Plex-Provides': 'server',
					'X-Plex-Product': 'Plex Media Server',
					'User-Agent': 'PlexMediaServer/1.43.0.10231-ca3956848',
				},
				timeout: 30000,
			});

			await new Promise((resolve, reject) => setTimeout(resolve, 1000))

			if (response?.items === undefined) continue;

			for (let item of response.items) {
				let plexItem = await this.metadataService.getItem(item.guid?.split('/').pop() as string)

				if (item.viewState === 'complete') {
					await this.scrobble(plexItem as Metadata, {
						id: userId
					})
				} else if (item.viewState === 'unplayed') {
					await this.unscrobble(plexItem as Metadata, {
						id: userId
					})
				}
			}

			if (response?.pageInfo?.hasNextPage == false) break;

			cursor = response?.pageInfo?.endCursor;

			await db
				.insertInto('scrobble_sync')
				.values({ account_id: userId, cursor: cursor ?? null, viewed_at: now, updated_at: now })
				.onConflict((oc) => oc.column('account_id').doUpdateSet({ cursor: cursor ?? null, viewed_at: now, updated_at: now }))
				.execute();
		}
	}
}

type ScrobbleAccess = {
	token: string;
	endpoint: string;
	expiresAt: number;
};
