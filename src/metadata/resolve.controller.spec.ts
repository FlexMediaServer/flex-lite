import { describe, expect, it, vi } from 'vitest';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { Metadata } from '../dto/Metadata.entity.js';

vi.hoisted(() => {
	process.env.DATABASE_URL = 'sqlite://:memory:';
});

//main.ts bootstraps the server on import, so only its PROXY flag is needed here
vi.mock('../main.js', () => ({ PROXY: { enabled: false } }));

const { ResolveController } = await import('./resolve.controller.js');

const localItem = (partKey?: string) => ({ Media: partKey ? [{ Part: [{ key: partKey }] }] : [{ Part: [] }] }) as unknown as Metadata;

function controller(item: Partial<Metadata> | null, resolved: Metadata | null = null) {
	const metadataService = { getItem: vi.fn(async () => item) };
	const appService = { resolveMedia: vi.fn(async () => resolved) };
	return { resolveController: new ResolveController(metadataService as any, appService as any), appService };
}

describe('resolve', () => {
	it('redirects a movie to the part file of its local media', async () => {
		const { resolveController, appService } = controller({ type: 'movie', guid: 'plex://movie/1' }, localItem('/library/parts/9/file.mkv'));

		const redirect = await resolveController.resolve('1');

		expect(appService.resolveMedia).toHaveBeenCalled();
		expect(redirect).toEqual({ url: '/library/parts/9/file.mkv', statusCode: 302 });
	});

	it('redirects an episode the same way', async () => {
		const { resolveController } = controller({ type: 'episode', guid: 'plex://episode/2' }, localItem('/library/parts/10/file.mkv'));

		expect(await resolveController.resolve('2')).toEqual({ url: '/library/parts/10/file.mkv', statusCode: 302 });
	});

	it('404s when the item does not exist', async () => {
		const { resolveController } = controller(null);

		await expect(resolveController.resolve('missing')).rejects.toBeInstanceOf(NotFoundException);
	});

	it('400s for types other than movie or episode', async () => {
		const { resolveController } = controller({ type: 'show', guid: 'plex://show/3' });

		await expect(resolveController.resolve('3')).rejects.toBeInstanceOf(BadRequestException);
	});

	it('404s when no media or part can be resolved', async () => {
		const noMedia = controller({ type: 'movie', guid: 'plex://movie/4' }, null);
		await expect(noMedia.resolveController.resolve('4')).rejects.toBeInstanceOf(NotFoundException);

		const noPart = controller({ type: 'movie', guid: 'plex://movie/5' }, localItem());
		await expect(noPart.resolveController.resolve('5')).rejects.toBeInstanceOf(NotFoundException);
	});
});
