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

/** Episodes and movies are the only items with progress rows of their own. */
const isLeaf = (item: Metadata) => item.type === 'episode' || item.type === 'movie';

/** The distinct guids of the given items, skipping any without one. */
const guidsOf = (items: Metadata[]) => [...new Set(items.map((item) => item.guid).filter((guid): guid is string => !!guid))];

/** Splits a list into batches so one multi-row statement stays under the engine's parameter limit. */
function chunked<T>(items: T[], size = 100): T[][] {
	const batches: T[][] = [];
	for (let i = 0; i < items.length; i += size) batches.push(items.slice(i, i + size));
	return batches;
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
	 * Only episodes and movies have rows. A show or season is expanded to its episodes first, so
	 * every episode carries its own state and a container's state is counted from them in `getState`.
	 *
	 * - `scrobble` marks the leaf watched and stamps `last_viewed_at`, resetting `view_offset` since
	 *   a scrobble only happens at the end of an item. A single episode or movie adds one to
	 *   `view_count`; a container only sets it to 1 where it is still unwatched, so a show-level
	 *   scrobble doesn't inflate the counts of episodes already watched.
	 * - `timeline` stores the current `viewOffset` (milliseconds) and stamps `last_viewed_at`, leaving
	 *   `view_count` alone. It also clears a movie's `-1` hide marker, as any progress update does.
	 * - `unscrobble` deletes the rows. An episode with no row is unwatched, so no empty rows are kept.
	 *   Unscrobbling a show also deletes its own `-1` hide marker.
	 *
	 * The show's `-1` hide marker, written by `removeFromContinueWatching`, is the only row that is
	 * neither an episode nor a movie.
	 */
	async updateState(item: Metadata, user: MyPlexUser, update: ProgressUpdate = { type: 'scrobble' }): Promise<void> {
		const guid = item?.guid;
		if (!user?.id || !guid) return;
		const accountId = user.id;

		//Items served the not found video are not really played, so their progress is never recorded
		if (await this.pmsService.isNotFoundItem(item)) return;

		//A timeline position only means something for the item actually playing, never for a container
		if (update.type === 'timeline' && !isLeaf(item)) return;

		const leaves = isLeaf(item) ? [item] : await this.metadataService.getLeaves(item);

		if (update.type === 'unscrobble') {
			await this.deleteRows(accountId, [...leaves.map((leaf) => leaf.guid), item.type === 'show' ? guid : undefined]);
			return;
		}

		const now = Math.floor(Date.now() / 1000);
		const scrobble = update.type === 'scrobble';

		const rows = leaves
			.filter((leaf): leaf is Metadata & { guid: string } => !!leaf.guid)
			.map((leaf) => ({
				account_id: accountId,
				guid: leaf.guid,
				parent_guid: leaf.parentGuid ?? null,
				grandparent_guid: leaf.grandparentGuid ?? null,
				index: leaf.index ?? null,
				parent_index: leaf.parentIndex ?? null,
				view_count: scrobble ? 1 : 0,
				view_offset: update.type === 'timeline' ? update.viewOffset : 0,
				last_viewed_at: scrobble || update.type === 'timeline' ? now : null,
				updated_at: now,
			}));

		const viewCount = scrobble
			? sql<number>`case when coalesce(view_count, 0) > 0 then view_count + ${isLeaf(item) ? 1 : 0} else 1 end`
			: sql<number>`case when view_count = -1 then 0 else view_count end`;

		for (const batch of chunked(rows)) {
			await db
				.insertInto('progress')
				.values(batch)
				.onConflict((oc) =>
					oc.columns(['account_id', 'guid']).doUpdateSet((eb) => ({
						parent_guid: eb.ref('excluded.parent_guid'),
						grandparent_guid: eb.ref('excluded.grandparent_guid'),
						index: eb.ref('excluded.index'),
						parent_index: eb.ref('excluded.parent_index'),
						view_count: viewCount,
						view_offset: eb.ref('excluded.view_offset'),
						last_viewed_at: eb.ref('excluded.last_viewed_at'),
						updated_at: eb.ref('excluded.updated_at'),
					})),
				)
				.execute();
		}
	}

	/** Deletes the progress rows for the given guids, ignoring any that are missing. */
	private async deleteRows(accountId: number, guids: (string | undefined)[]): Promise<void> {
		const ids = guids.filter((guid): guid is string => !!guid);
		for (const batch of chunked(ids)) {
			await db.deleteFrom('progress').where('account_id', '=', accountId).where('guid', 'in', batch).execute();
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
	 * Resolves playback state for a batch of metadata items purely from the local `progress` table.
	 *
	 * Episodes and movies report their own row. A show or season has no row, so its state is counted
	 * from the watched episode rows under it (`grandparent_guid` for a show, `parent_guid` for a
	 * season) and reported as `viewedLeafCount`. It is complete once that count reaches `leafCount`.
	 * A `-1` view count is the Continue Watching hide marker and is never a watched state.
	 */
	async getState(items: Metadata[], user: MyPlexUser): Promise<PlexUserState[]> {
		if (!user?.id || !items.length) return [];
		const accountId = user.id;

		const leafGuids = guidsOf(items.filter(isLeaf));
		const showGuids = guidsOf(items.filter((item) => item.type === 'show'));
		const seasonGuids = guidsOf(items.filter((item) => item.type === 'season'));
		if (!leafGuids.length && !showGuids.length && !seasonGuids.length) return [];

		const rows = await db
			.selectFrom('progress')
			.select(['guid', 'grandparent_guid', 'parent_guid', 'view_count', 'view_offset', 'last_viewed_at'])
			.where('account_id', '=', accountId)
			.where((eb) =>
				eb.or([
					...(leafGuids.length ? [eb('guid', 'in', leafGuids)] : []),
					...(showGuids.length ? [eb('grandparent_guid', 'in', showGuids)] : []),
					...(seasonGuids.length ? [eb('parent_guid', 'in', seasonGuids)] : []),
				]),
			)
			.execute();

		//Watched episodes per show and per season. Every episode of a container in `items` is in `rows`.
		const watchedByShow = new Map<string, number>();
		const watchedBySeason = new Map<string, number>();
		for (const row of rows) {
			if (!((row.view_count ?? 0) > 0)) continue;
			if (row.grandparent_guid) watchedByShow.set(row.grandparent_guid, (watchedByShow.get(row.grandparent_guid) ?? 0) + 1);
			if (row.parent_guid) watchedBySeason.set(row.parent_guid, (watchedBySeason.get(row.parent_guid) ?? 0) + 1);
		}

		//-1 is the Continue Watching hide marker, not a watched state.
		const entries = new Map(rows.filter((row) => row.view_count !== -1).map((row) => [row.guid, row] as const));

		//State is matched by the caller on the plain id, matching getUserState.
		const ratingKeyOf = (item: Metadata) => (item.ratingKey || item.key)?.split('/').pop();

		const states: PlexUserState[] = [];

		for (const item of items) {
			if (!item.guid) continue;

			if (item.type === 'show' || item.type === 'season') {
				const watchedCount = (item.type === 'show' ? watchedByShow : watchedBySeason).get(item.guid) ?? 0;
				if (!watchedCount) continue;

				const watched = !!item.leafCount && watchedCount >= item.leafCount;
				states.push({
					ratingKey: ratingKeyOf(item),
					viewCount: watched ? 1 : 0,
					viewedLeafCount: watchedCount,
					viewState: watched ? 'complete' : 'unplayed',
				});
				continue;
			}

			const entry = entries.get(item.guid);
			if (!entry) continue;

			const viewCount = entry.view_count ?? 0;
			states.push({
				ratingKey: ratingKeyOf(item),
				viewCount,
				viewOffset: entry.view_offset ?? 0,
				lastViewedAt: entry.last_viewed_at ?? undefined,
				viewState: viewCount > 0 ? 'complete' : 'unplayed',
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

type ProgressUpdate = { type: 'scrobble' } | { type: 'unscrobble' } | { type: 'timeline'; viewOffset: number };
