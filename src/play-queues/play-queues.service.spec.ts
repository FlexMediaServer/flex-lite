import { describe, expect, it, vi } from 'vitest';
import type { Metadata } from '../dto/Metadata.entity.js';

vi.hoisted(() => {
	process.env.DATABASE_URL = 'sqlite://:memory:';
});

//main.ts bootstraps the server on import, so only its PROXY flag is needed here
vi.mock('../main.js', () => ({ PROXY: { enabled: false } }));

const { PlayQueuesService } = await import('./play-queues.service.js');

const episode = (n: number) => ({ guid: `plex://episode/${n}`, ratingKey: String(n) }) as Metadata;
const queue = (currentItem: string, offset: number) => ({ playbackSessionId: 's', item: 'plex://show/1', currentItem, offset }) as any;

describe('findNext', () => {
	it('returns the following item from the current window', async () => {
		const service = new PlayQueuesService({} as any);
		const items = [episode(1), episode(2), episode(3)];

		const next = await service.findNext(queue('plex://episode/1', 10), items);

		expect(next).toEqual({ item: items[1], offset: 11 });
	});

	it('pages to the next window when the current item is the last one', async () => {
		const service = new PlayQueuesService({} as any);
		const items = [episode(1), episode(2)];
		const fetchWindow = vi.spyOn(service, 'fetchWindow').mockResolvedValue({ items: [episode(3)], totalSize: 3 });

		const next = await service.findNext(queue('plex://episode/2', 10), items);

		expect(fetchWindow).toHaveBeenCalledWith(expect.objectContaining({ offset: 12 }));
		expect(next).toEqual({ item: episode(3), offset: 12 });
	});

	it('moves one step on when the current item is not in the window', async () => {
		const service = new PlayQueuesService({} as any);
		const fetchWindow = vi.spyOn(service, 'fetchWindow').mockResolvedValue({ items: [episode(5)], totalSize: 5 });

		const next = await service.findNext(queue('plex://episode/99', 4), [episode(1)]);

		expect(fetchWindow).toHaveBeenCalledWith(expect.objectContaining({ offset: 5 }));
		expect(next).toEqual({ item: episode(5), offset: 5 });
	});
});
