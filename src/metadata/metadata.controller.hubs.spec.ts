import { describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
	process.env.DATABASE_URL = 'sqlite://:memory:';
});

//main.ts bootstraps the server on import, so only its PROXY flag is needed here
vi.mock('../main.js', () => ({ PROXY: { enabled: false } }));

const { MetadataController } = await import('./metadata.controller.js');
const { Hub } = await import('../dto/Hub.entity.js');

//Home hubs are shared across users, so the hub list is built once and each request must leave it alone
function build() {
	const hubs = [
		new Hub({ hubIdentifier: 'stremio.movie.top', type: 'movie', title: 'Top', key: '', hubKey: '', more: false, Metadata: [{ guid: 'g1', ratingKey: 'r1', type: 'movie', title: 'Heat' } as any] }),
	];

	//Stands in for the real hydration: writes the viewer's progress onto the items it is given
	const hydrateMetadata = vi.fn(async (items: any[], user: any) => {
		for (const item of items) {
			item.viewOffset = 5000 * user.id;
			item.userState = true;
		}
		return items;
	});

	const pms = { plexUserApi: vi.fn(() => async () => ({ MediaContainer: { Hub: [] } })) };
	const sections = { get: () => undefined, stamp: (item: any) => item, isVirtual: () => false, containerOf: () => ({}) };
	const metadataService = { hubs, hydrateMetadata };

	return { controller: new MetadataController({} as any, metadataService as any, {} as any, pms as any, sections as any), hubs, hydrateMetadata };
}

describe('MetadataController hub hydration', () => {
	it('hydrates the home hub items for the requesting user', async () => {
		const { controller } = build();
		const response = (await controller.promoted({}, {} as any, false, { 'x-plex-token': 't' }, { id: 7 } as any))!;
		const [hub] = response.MediaContainer.Hub!;

		expect(hub.Metadata?.[0]).toMatchObject({ title: 'Heat', viewOffset: 35000, userState: true });
	});

	it('leaves the shared hub items untouched, so one user\'s progress never reaches another', async () => {
		const { controller, hubs } = build();
		await controller.promoted({}, {} as any, false, { 'x-plex-token': 't' }, { id: 7 } as any);
		const response = (await controller.promoted({}, {} as any, false, { 'x-plex-token': 't' }, { id: 8 } as any))!;

		expect(hubs[0].Metadata?.[0]).not.toHaveProperty('viewOffset');
		expect(response.MediaContainer.Hub![0].Metadata?.[0].viewOffset).toBe(40000);
	});

	it('hydrates the items of a hub page for the requesting user, without touching the shared items', async () => {
		const { controller, hubs } = build();
		const response = await controller.getHubItems({ id: 'stremio.movie.top' }, {} as any, {}, false, { id: 7 } as any);

		expect(response.MediaContainer.Metadata?.[0]).toMatchObject({ title: 'Heat', viewOffset: 35000 });
		expect(hubs[0].Metadata?.[0]).not.toHaveProperty('viewOffset');
	});
});
