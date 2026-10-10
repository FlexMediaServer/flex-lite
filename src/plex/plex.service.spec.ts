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
const { PMSService } = await import('./plex.service.js');
const { ScrobblingService } = await import('../scrobbling/scrobbling.service.js');

const item = (id: string, type: 'movie' | 'episode' = 'movie') => ({ guid: `plex://${type}/${id}`, type }) as Metadata;

//Fake Plex: ingests return a new id each time, and only ids in `alive` exist.
function fakePlex(pms: InstanceType<typeof PMSService>) {
	const alive = new Set<string>();
	let next = 100;
	const ingest = vi.fn(async () => {
		const id = String(next++);
		alive.add(id);
		return { MediaContainer: { Metadata: [{ key: `/library/metadata/${id}` }] } };
	});

	pms.plexServerApi = vi.fn(async (path: string, options?: { method?: string; query?: any }) => {
		if (path === '/library/file' && options?.method === 'POST') return ingest();
		const match = path.match(/^\/library\/metadata\/(\d+)$/);
		if (match && options?.method === 'DELETE') {
			alive.delete(match[1]);
			return {};
		}
		if (match) {
			if (!alive.has(match[1])) throw Object.assign(new Error('not found'), { status: 404 });
			return { MediaContainer: { Metadata: [{ ratingKey: match[1] }] } };
		}
		throw new Error(`unexpected Plex call ${path}`);
	}) as any;

	return { ingest, alive };
}

beforeAll(async () => {
	await sql`CREATE TABLE item_mappings (guid text primary key, item_id text not null, url text not null, constraint mapping_unique unique (guid, item_id, url))`.execute(db);
	await sql`CREATE TABLE progress (id integer primary key autoincrement, account_id integer, guid text not null, parent_guid text, grandparent_guid text, "index" integer, parent_index integer, view_count integer, view_offset integer, last_viewed_at integer, updated_at integer, created_at integer, constraint progress_unique unique (account_id, guid))`.execute(db);
});

beforeEach(async () => {
	await sql`DELETE FROM item_mappings`.execute(db);
	await sql`DELETE FROM progress`.execute(db);
});

describe('not found video', () => {
	it('returns the same Plex not found item to every caller and ingests it once', async () => {
		const pms = new PMSService();
		const plex = fakePlex(pms);

		const first = await pms.getNotFoundItem();
		const second = await pms.getNotFoundItem();
		const third = await pms.getNotFoundItem();

		expect(first.ratingKey).toBe(second.ratingKey);
		expect(second.ratingKey).toBe(third.ratingKey);
		expect(plex.ingest).toHaveBeenCalledTimes(1);
	});

	it('shares one ingest between concurrent resolves', async () => {
		const pms = new PMSService();
		const plex = fakePlex(pms);

		const items = await Promise.all([pms.getNotFoundItem(), pms.getNotFoundItem(), pms.getNotFoundItem()]);

		expect(new Set(items.map((i) => i.ratingKey)).size).toBe(1);
		expect(plex.ingest).toHaveBeenCalledTimes(1);
	});

	it('maps the item to the shared copy with the actual video url', async () => {
		const pms = new PMSService();
		fakePlex(pms);

		const copy = await pms.addNotFound(item('a'));

		const mapped = await db.selectFrom('item_mappings').select(['item_id', 'url']).where('guid', '=', 'a').executeTakeFirst();
		expect(mapped).toEqual({ item_id: copy?.ratingKey, url: 'http://127.0.0.1:32404/assets/MediaNotFound.mp4' });
	});

	it('recognises an item served the not found video and never a real stream', async () => {
		const pms = new PMSService();
		fakePlex(pms);

		await pms.addNotFound(item('a'));
		expect(await pms.isNotFoundItem(item('a'))).toBe(true);
		expect(await pms.isNotFoundItem(item('never-mapped'))).toBe(false);
	});

	it('keeps the shared copy in Plex even when its mapping url no longer matches the configured video', async () => {
		const pms = new PMSService();
		const plex = fakePlex(pms);

		const copy = await pms.addNotFound(item('a'));
		await sql`UPDATE item_mappings SET url = 'https://old.example/MediaNotFound.mp4' WHERE guid = 'a'`.execute(db);
		await pms.removeMapping(item('a'));

		expect(plex.alive.has(copy?.ratingKey as string)).toBe(true);
	});

	it('replaces the shared copy when the not found video url changes', async () => {
		const pms = new PMSService();
		const plex = fakePlex(pms);
		const originalUrl = process.env.MEDIA_NOT_FOUND_VIDEO;

		try {
			const before = await pms.addNotFound(item('a'));
			process.env.MEDIA_NOT_FOUND_VIDEO = 'http://127.0.0.1:32404/assets/Other.mp4';
			const after = await pms.addNotFound(item('b'));

			expect(after?.ratingKey).not.toBe(before?.ratingKey);
			expect(plex.alive.has(before?.ratingKey as string)).toBe(false);
			expect(plex.ingest).toHaveBeenCalledTimes(2);
			expect(await pms.isNotFoundItem(item('a'))).toBe(false);
			expect(await pms.isNotFoundItem(item('b'))).toBe(true);

			const row = await db.selectFrom('item_mappings').select('url').where('guid', '=', 'flex:not-found').executeTakeFirst();
			expect(row?.url).toBe('http://127.0.0.1:32404/assets/Other.mp4');
		} finally {
			process.env.MEDIA_NOT_FOUND_VIDEO = originalUrl;
		}
	});

	it('removing the mapping of a not found item keeps the shared copy in Plex', async () => {
		const pms = new PMSService();
		const plex = fakePlex(pms);

		const copy = await pms.addNotFound(item('a'));
		await pms.removeMapping(item('a'));

		expect(plex.alive.has(copy?.ratingKey as string)).toBe(true);
		expect(await pms.resolveMappedUrl(item('a'))).toBeNull();
	});

	it('stores the actual not found video URL on the shared copy', async () => {
		const pms = new PMSService();
		fakePlex(pms);

		await pms.getNotFoundItem();

		const row = await db.selectFrom('item_mappings').select('url').where('guid', '=', 'flex:not-found').executeTakeFirst();
		expect(row?.url).toBe('http://127.0.0.1:32404/assets/MediaNotFound.mp4');
	});

	it('re-ingests when the shared copy has gone from Plex', async () => {
		const pms = new PMSService();
		const plex = fakePlex(pms);

		const before = await pms.getNotFoundItem();
		plex.alive.delete(before.ratingKey as string);

		const after = await pms.getNotFoundItem();
		expect(after.ratingKey).not.toBe(before.ratingKey);
		expect(plex.ingest).toHaveBeenCalledTimes(2);
	});

	it('does not record progress for an item served the not found video', async () => {
		const pms = new PMSService();
		fakePlex(pms);
		const scrobbling = new ScrobblingService(pms, {} as any);
		const user = { id: 1 } as MyPlexUser;

		await pms.addNotFound(item('placeholder'));
		await scrobbling.scrobble(item('placeholder'), user);
		await scrobbling.timeline(item('placeholder'), user, 5000);
		await scrobbling.unscrobble(item('placeholder'), user);

		const rows = await db.selectFrom('progress').selectAll().execute();
		expect(rows).toHaveLength(0);
	});

	it('still records progress for an item with its own media', async () => {
		const pms = new PMSService();
		fakePlex(pms);
		const scrobbling = new ScrobblingService(pms, {} as any);

		await scrobbling.timeline(item('real'), { id: 1 } as MyPlexUser, 5000);

		const rows = await db.selectFrom('progress').select(['guid', 'view_offset']).execute();
		expect(rows).toEqual([{ guid: 'plex://movie/real', view_offset: 5000 }]);
	});
});
