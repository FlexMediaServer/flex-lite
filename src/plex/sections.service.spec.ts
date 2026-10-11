import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Metadata } from '../dto/Metadata.entity.js';

vi.hoisted(() => {
	process.env.DATABASE_URL = 'sqlite://:memory:';
});

//main.ts bootstraps the server on import, so only its PROXY flag is needed here
vi.mock('../main.js', () => ({ PROXY: { enabled: false } }));

const { SectionsService } = await import('./sections.service.js');

//Sample /library/sections response: movies and shows under /virtual are Flex's, plus one real section
const sectionsResponse = {
	MediaContainer: {
		Directory: [
			{ key: '1', type: 'movie', title: 'Movies', Location: [{ id: 3, path: '/virtual/Movies' }] },
			{ key: '2', type: 'show', title: 'TV Shows', Location: [{ id: 4, path: '/virtual/Shows' }] },
			{ key: '5', type: 'movie', title: 'Home Videos', Location: [{ id: 9, path: '/mnt/home' }] },
		],
	},
};

function build(response: any) {
	const pms = { plexServerApi: vi.fn(async () => response) };
	return { pms, sections: new SectionsService(pms as any) };
}

describe('SectionsService', () => {
	let sections: InstanceType<typeof SectionsService>;

	beforeEach(async () => {
		({ sections } = build(sectionsResponse));
		await sections.refreshIfStale();
	});

	it('takes over only sections whose location starts with /virtual', () => {
		expect(sections.enabled).toBe(true);
		expect(sections.isVirtual('1')).toBe(true);
		expect(sections.isVirtual('2')).toBe(true);
		expect(sections.isVirtual('5')).toBe(false);
	});

	it('files each item under the section for its type', () => {
		expect(sections.stamp({ type: 'movie' } as Metadata)).toMatchObject({ librarySectionID: 1, librarySectionKey: '/library/sections/1', librarySectionTitle: 'Movies' });
		expect(sections.stamp({ type: 'episode' } as Metadata)).toMatchObject({ librarySectionID: 2, librarySectionTitle: 'TV Shows' });
		expect(sections.stamp({ type: 'season' } as Metadata)).toMatchObject({ librarySectionID: 2 });
		expect(sections.stamp({ type: 'clip' } as Metadata).librarySectionID).toBeUndefined();
	});

	it('names a container section only when all items share one', () => {
		expect(sections.containerOf([{ type: 'episode' }, { type: 'season' }] as Metadata[])).toEqual({ librarySectionID: 2, librarySectionTitle: 'TV Shows' });
		expect(sections.containerOf([{ type: 'episode' }, { type: 'movie' }] as Metadata[])).toEqual({});
	});

	it('takes over nothing when no section is virtual', async () => {
		({ sections } = build({ MediaContainer: { Directory: [{ key: '1', type: 'movie', title: 'Movies', Location: [{ path: '/data/movies' }] }] } }));
		await sections.refreshIfStale();

		expect(sections.enabled).toBe(false);
		expect(sections.stamp({ type: 'movie' } as Metadata).librarySectionID).toBeUndefined();
	});

	it('keeps the last known sections when Plex cannot be reached', async () => {
		const { pms, sections: flaky } = build(sectionsResponse);
		await flaky.refreshIfStale();

		pms.plexServerApi.mockRejectedValueOnce(new Error('offline'));
		vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 61_000);
		await flaky.refreshIfStale();

		expect(flaky.enabled).toBe(true);
		vi.restoreAllMocks();
	});
});
