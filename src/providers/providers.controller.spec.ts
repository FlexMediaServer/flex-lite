import { describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
	process.env.DATABASE_URL = 'sqlite://:memory:';
});

//main.ts bootstraps the server on import, so only its PROXY flag is needed here
const { get } = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('../main.js', () => ({ PROXY: { enabled: false } }));
vi.mock('axios', () => ({ default: { get } }));
const { ProvidersController } = await import('./providers.controller.js');

const pivots = [
	{ id: 'categories', symbol: 'stack' },
	{ id: 'library', symbol: 'library' },
	{ id: 'recommended', symbol: 'star' }
];

//Sample /media/providers response: section 1 is virtual, section 3 is real Plex
const providersResponse = () => ({
	MediaContainer: {
		MediaProvider: {
			Feature: {
				Directory: [
					{ id: '1', key: '/library/sections/1', Pivot: pivots.map((pivot) => ({ ...pivot })) },
					{ id: '3', key: '/library/sections/3', Pivot: pivots.map((pivot) => ({ ...pivot })) }
				]
			}
		}
	}
});

describe('ProvidersController', () => {
	const build = (virtualKeys: string[]) => {
		const sections = { isVirtual: (key: string | number | undefined) => virtualKeys.includes(String(key)) };
		return new ProvidersController(sections as any);
	};

	it('takes over only virtual sections, dropping the library and categories pivots', async () => {
		get.mockResolvedValueOnce({ data: providersResponse() });
		const [virtual, real] = (await build(['1']).providers({}, {}) as any).MediaContainer.MediaProvider.Feature.Directory;

		expect(virtual.Pivot.map((pivot: any) => pivot.id)).toEqual(['recommended']);
		expect(real.Pivot.map((pivot: any) => pivot.id)).toEqual(['categories', 'library', 'recommended']);
	});

	it('leaves every section alone when none is virtual', async () => {
		get.mockResolvedValueOnce({ data: providersResponse() });
		const [first, second] = (await build([]).providers({}, {}) as any).MediaContainer.MediaProvider.Feature.Directory;

		expect(first.Pivot).toHaveLength(3);
		expect(second.Pivot).toHaveLength(3);
	});
});
