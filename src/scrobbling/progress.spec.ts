import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sql } from 'kysely';
import type { Metadata } from '../dto/Metadata.entity.js';

vi.hoisted(() => {
	process.env.DATABASE_URL = 'sqlite://:memory:';
	process.env.MEDIA_NOT_FOUND_VIDEO = 'http://127.0.0.1:32404/assets/MediaNotFound.mp4';
});

//main.ts bootstraps the server on import, so only its PROXY flag is needed here
vi.mock('../main.js', () => ({ PROXY: { enabled: false } }));

const { db } = await import('../utils/database.js');
const { ScrobblingService } = await import('./scrobbling.service.js');
const { MetadataService } = await import('../metadata/metadata.service.js');

const user = { id: 1 } as MyPlexUser;

const SHOW = { type: 'show', guid: 'plex://show/s1', ratingKey: '100', leafCount: 4 } as Metadata;
const SEASON_1 = { type: 'season', guid: 'plex://season/a', ratingKey: '101', index: 1, parentGuid: SHOW.guid, leafCount: 2 } as Metadata;
const SEASON_2 = { type: 'season', guid: 'plex://season/b', ratingKey: '102', index: 2, parentGuid: SHOW.guid, leafCount: 2 } as Metadata;

const episode = (id: string, index: number, season: Metadata) =>
	({
		type: 'episode',
		guid: `plex://episode/${id}`,
		index,
		parentIndex: season.index,
		parentGuid: season.guid,
		grandparentGuid: SHOW.guid,
		grandparentRatingKey: SHOW.ratingKey,
	}) as Metadata;

const EPISODES_BY_SEASON: Record<string, Metadata[]> = {
	[SEASON_1.ratingKey]: [episode('e1', 1, SEASON_1), episode('e2', 2, SEASON_1)],
	[SEASON_2.ratingKey]: [episode('e3', 1, SEASON_2), episode('e4', 2, SEASON_2)],
};

const ALL_EPISODES = Object.values(EPISODES_BY_SEASON).flat();
const episodeById = new Map(ALL_EPISODES.map((ep) => [ep.guid!.split('/').pop()!, ep] as const));

const pms = { isNotFoundItem: async () => false, resolveLocalItem: async () => [] } as any;

function setup() {
	const metadata = new MetadataService(pms, {} as any, undefined as any, {} as any);
	vi.spyOn(metadata, 'getItemChildren').mockImplementation(async (id: string) =>
		id === SHOW.ratingKey ? [SEASON_1, SEASON_2] : (EPISODES_BY_SEASON[id] ?? []),
	);
	vi.spyOn(metadata, 'getItem').mockImplementation(async (id: string) => {
		if (id === 'show1') return SHOW;
		return episodeById.get(id) ?? null;
	});
	const scrobbling = new ScrobblingService(pms, metadata);
	//The two services depend on each other, so the scrobbling service is wired in once both exist
	(metadata as any).scrobblingService = scrobbling;
	return { metadata, scrobbling };
}

beforeAll(async () => {
	await sql`CREATE TABLE item_mappings (guid text primary key, item_id text not null, url text not null, constraint mapping_unique unique (guid, item_id, url))`.execute(db);
	await sql`CREATE TABLE progress (id integer primary key autoincrement, account_id integer, guid text not null, parent_guid text, grandparent_guid text, "index" integer, parent_index integer, view_count integer, view_offset integer, last_viewed_at integer, updated_at integer, created_at integer, constraint progress_unique unique (account_id, guid))`.execute(db);
});

beforeEach(async () => {
	vi.restoreAllMocks();
	await sql`DELETE FROM progress`.execute(db);
});

describe('episode rows', () => {
	it('scrobbling a show writes one row per episode and no show or season rows', async () => {
		const { scrobbling } = setup();

		await scrobbling.scrobble(SHOW, user);

		const rows = await db.selectFrom('progress').select(['guid', 'grandparent_guid', 'parent_guid', 'view_count']).orderBy('guid').execute();
		expect(rows).toEqual([
			{ guid: 'plex://episode/e1', grandparent_guid: SHOW.guid, parent_guid: SEASON_1.guid, view_count: 1 },
			{ guid: 'plex://episode/e2', grandparent_guid: SHOW.guid, parent_guid: SEASON_1.guid, view_count: 1 },
			{ guid: 'plex://episode/e3', grandparent_guid: SHOW.guid, parent_guid: SEASON_2.guid, view_count: 1 },
			{ guid: 'plex://episode/e4', grandparent_guid: SHOW.guid, parent_guid: SEASON_2.guid, view_count: 1 },
		]);
	});

	it('a show-level scrobble leaves already watched episodes at their play count', async () => {
		const { scrobbling } = setup();

		await scrobbling.scrobble(episodeById.get('e1')!, user);
		await scrobbling.scrobble(episodeById.get('e1')!, user);
		await scrobbling.scrobble(SHOW, user);

		const row = await db.selectFrom('progress').select('view_count').where('guid', '=', 'plex://episode/e1').executeTakeFirst();
		expect(row?.view_count).toBe(2);
	});

	it('unscrobbling a show deletes its episode rows and its hide marker, and leaves other shows alone', async () => {
		const { scrobbling } = setup();
		await scrobbling.scrobble(SHOW, user);
		await db
			.insertInto('progress')
			.values({ account_id: 1, guid: 'plex://episode/x', parent_guid: 'plex://season/z', grandparent_guid: 'plex://show/other', index: 1, parent_index: 1, view_count: 1, view_offset: 0, last_viewed_at: 1, updated_at: 1, created_at: 1 })
			.execute();

		await scrobbling.unscrobble(SHOW, user);

		const guids = (await db.selectFrom('progress').select('guid').execute()).map((row) => row.guid);
		expect(guids).toEqual(['plex://episode/x']);
	});

	it('unscrobbling a single episode deletes its row so it reads as unwatched', async () => {
		const { scrobbling } = setup();
		await scrobbling.scrobble(episodeById.get('e1')!, user);

		await scrobbling.unscrobble(episodeById.get('e1')!, user);

		expect(await db.selectFrom('progress').selectAll().execute()).toEqual([]);
	});
});

describe('derived container state', () => {
	it('counts a season and show from their watched episodes', async () => {
		const { scrobbling } = setup();
		await scrobbling.scrobble(episodeById.get('e1')!, user);
		await scrobbling.scrobble(episodeById.get('e2')!, user);

		const states = await scrobbling.getState([SHOW, SEASON_1, SEASON_2], user);

		expect(states).toEqual([
			expect.objectContaining({ ratingKey: SHOW.ratingKey, viewedLeafCount: 2, viewCount: 0, viewState: 'unplayed' }),
			expect.objectContaining({ ratingKey: SEASON_1.ratingKey, viewedLeafCount: 2, viewCount: 1, viewState: 'complete' }),
		]);
	});

	it('marks a show complete once every episode is watched', async () => {
		const { scrobbling } = setup();
		await scrobbling.scrobble(SHOW, user);

		const [state] = await scrobbling.getState([SHOW], user);

		expect(state).toMatchObject({ ratingKey: SHOW.ratingKey, viewedLeafCount: 4, viewCount: 1, viewState: 'complete' });
	});
});

describe('continue watching', () => {
	it('resumes at the next unwatched episode after a finished one', async () => {
		const { metadata, scrobbling } = setup();
		await scrobbling.scrobble(episodeById.get('e1')!, user);

		const shelf = await metadata.getContinueWatching(user);

		expect(shelf.map((item) => item.guid)).toEqual(['plex://episode/e2']);
	});

	it('crosses into the next season when the current one is finished', async () => {
		const { metadata, scrobbling } = setup();
		await scrobbling.scrobble(episodeById.get('e2')!, user);

		const shelf = await metadata.getContinueWatching(user);

		expect(shelf.map((item) => item.guid)).toEqual(['plex://episode/e3']);
	});

	it('drops a show whose episodes are all watched', async () => {
		const { metadata, scrobbling } = setup();
		await scrobbling.scrobble(SHOW, user);

		expect(await metadata.getContinueWatching(user)).toEqual([]);
	});

	it('resumes a mid-way episode directly', async () => {
		const { metadata, scrobbling } = setup();
		await scrobbling.timeline(episodeById.get('e3')!, user, 5000);

		const shelf = await metadata.getContinueWatching(user);

		expect(shelf.map((item) => item.guid)).toEqual(['plex://episode/e3']);
	});
});
