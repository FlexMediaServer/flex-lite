import { describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
	process.env.DATABASE_URL = 'sqlite://:memory:';
});

//main.ts bootstraps the server on import, so only its PROXY flag is needed here
vi.mock('../main.js', () => ({ PROXY: { enabled: false } }));

const { MetadataController } = await import('./metadata.controller.js');
const { SectionsService } = await import('../plex/sections.service.js');

//Section 2 is virtual (Flex's TV Shows); section 5 is a real Plex library holding the local show
const sectionsResponse = {
	MediaContainer: {
		Directory: [
			{ key: '2', type: 'show', title: 'TV Shows', Location: [{ id: 4, path: '/virtual/Shows' }] },
			{ key: '5', type: 'show', title: 'Local Shows', Location: [{ id: 9, path: '/mnt/shows' }] },
		],
	},
};

//Plex's /hubs/search: one local show in the real library, nothing in the virtual one
const localHubSearch = {
	MediaContainer: {
		Hub: [
			{
				hubIdentifier: 'show',
				type: 'show',
				title: 'Shows',
				Metadata: [{ ratingKey: '101', guid: 'plex://show/local', type: 'show', title: 'Local Show', librarySectionID: 5, librarySectionTitle: 'Local Shows', librarySectionKey: '/library/sections/5' }],
			},
		],
	},
};

//Same hub search, but Plex leaves the section off the item
const hubSearchWithoutSection = structuredClone(localHubSearch);
delete (hubSearchWithoutSection.MediaContainer.Hub[0].Metadata[0] as any).librarySectionID;

//Discover returns the same show under its own (hex) id, which Flex files under the virtual section
const discoverShow = { ratingKey: '5d9c0000000000000000aa01', guid: 'plex://show/local', type: 'show', title: 'Local Show' };

async function build(hubSearch: any = localHubSearch) {
	const pms = {
		plexServerApi: vi.fn(async () => sectionsResponse),
		plexUserApi: vi.fn(() => async () => structuredClone(hubSearch)), //Fresh copy: stamping mutates the response
	};
	const sections = new SectionsService(pms as any);
	await sections.refreshIfStale();

	const discover = { MediaContainer: { SearchResults: [{ id: 'external', SearchResult: [{ Metadata: structuredClone(discoverShow) }] }] } };
	const metadataService = { discoverApi: vi.fn(async () => structuredClone(discover)) };
	return new MetadataController({} as any, metadataService as any, {} as any, pms as any, sections);
}

describe('MetadataController search', () => {
	it('keeps a local show filed under its real Plex section, not the virtual one', async () => {
		const controller = await build();
		const { MediaContainer } = await controller.hubsSearch({ query: 'local' }, { 'x-plex-token': 'token' }, false);
		const [show] = (MediaContainer.Hub ?? []).flatMap((hub: any) => hub.Metadata ?? []);

		expect(show).toMatchObject({ title: 'Local Show', librarySectionID: 5, librarySectionTitle: 'Local Shows' });
	});

	it('does not file a local show under the virtual section when Plex leaves its section off', async () => {
		const controller = await build(hubSearchWithoutSection);
		const { MediaContainer } = await controller.hubsSearch({ query: 'local' }, { 'x-plex-token': 'token' }, false);
		const [show] = (MediaContainer.Hub ?? []).flatMap((hub: any) => hub.Metadata ?? []);

		expect(show.title).toBe('Local Show');
		expect(show.librarySectionID).toBeUndefined();
	});

	it('lists the local show and its virtual copy as separate results', async () => {
		const controller = await build();
		const { MediaContainer } = await controller.search({ query: 'local' }, { 'x-plex-token': 'token' });

		expect(MediaContainer.SearchResult.map((result: any) => [result.Metadata.title, result.Metadata.librarySectionID])).toEqual([
			['Local Show', 5],
			['Local Show', 2],
		]);
	});

	it('lists the local show and its virtual copy in the same hub', async () => {
		const controller = await build();
		const { MediaContainer } = await controller.hubsSearch({ query: 'local' }, { 'x-plex-token': 'token' }, false);
		const [hub] = MediaContainer.Hub ?? [];

		expect(hub.Metadata?.map((item: any) => item.librarySectionID)).toEqual([5, 2]);
	});
});
