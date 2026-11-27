import { describe, expect, it, vi } from 'vitest';
import type { Metadata } from './dto/Metadata.entity.js';

vi.hoisted(() => {
	process.env.DATABASE_URL = 'sqlite://:memory:';
});

//main.ts bootstraps the server on import, so only its PROXY flag is needed here
vi.mock('./main.js', () => ({ PROXY: { enabled: false } }));

//Every reused stream is answered as live here, so only the length decides a reuse
vi.mock('./utils/probe-url.js', () => ({ probeUrl: vi.fn(async () => true) }));

const { AppService } = await import('./app.service.js');

const MINUTE = 60 * 1000;
const RUNTIME = 90 * MINUTE;
const movie = { guid: 'plex://movie/1', duration: RUNTIME } as Metadata;

//A fake Plex server: each stream URL ingests into a copy that reports the length given for that URL.
//`existing` is a stream already mapped to the item before resolution starts.
function plexFake(lengths: Record<string, number>, existing?: string) {
	let ingested: string | undefined = existing;
	const copyOf = () => (ingested ? { Media: [{ duration: lengths[ingested] }] } : null);

	return {
		resolveLocalItem: vi.fn(async () => [copyOf()]),
		resolveMappedUrl: vi.fn(async () => existing ?? null),
		isNotFoundItem: vi.fn(async () => false),
		addStream: vi.fn(async (_item: Metadata, url: string) => {
			ingested = url;
			return `plex-${url}`;
		}),
		removeMapping: vi.fn(async () => {
			ingested = undefined;
		}),
		addNotFound: vi.fn(async () => ({ key: '/library/metadata/not-found', Media: [{ duration: 1 }] })),
	};
}

function stremioFake(urls: string[]) {
	return {
		streamCandidates: vi.fn(async () =>
			(async function* () {
				for (const url of urls) yield url;
			})(),
		),
	};
}

function resolve(lengths: Record<string, number>, urls: string[], existing?: string) {
	const pmsService = plexFake(lengths, existing);
	const stremioService = stremioFake(urls);
	const appService = new AppService(stremioService as any, pmsService as any);
	return { pmsService, stremioService, result: appService.resolveMedia(movie) };
}

describe('AppService.resolveMedia', () => {
	it('keeps the first stream whose length matches the item', async () => {
		const { pmsService, result } = resolve({ a: RUNTIME, b: RUNTIME }, ['a', 'b']);

		expect((await result)?.Media?.[0].duration).toBe(RUNTIME);
		expect(pmsService.addStream).toHaveBeenCalledTimes(1);
		expect(pmsService.removeMapping).not.toHaveBeenCalled();
	});

	it('drops a stream whose length does not match and takes the next one', async () => {
		const { pmsService, result } = resolve({ a: 20 * MINUTE, b: RUNTIME }, ['a', 'b']);

		expect((await result)?.Media?.[0].duration).toBe(RUNTIME);
		expect(pmsService.addStream.mock.calls.map(([, url]) => url)).toEqual(['a', 'b']);
		//The bad copy and its mapping are removed, so it is not cached
		expect(pmsService.removeMapping).toHaveBeenCalledTimes(1);
		expect(pmsService.addNotFound).not.toHaveBeenCalled();
	});

	it('falls back to the not found video when every stream mismatches', async () => {
		const { pmsService, result } = resolve({ a: 20 * MINUTE, b: 30 * MINUTE }, ['a', 'b']);

		expect(await result).toEqual({ key: '/library/metadata/not-found', Media: [{ duration: 1 }] });
		expect(pmsService.removeMapping).toHaveBeenCalledTimes(2);
		expect(pmsService.addNotFound).toHaveBeenCalledTimes(1);
	});

	it('drops a cached stream whose length does not match before reusing it', async () => {
		//The cached stream x mismatches; the candidate a matches
		const { pmsService, result } = resolve({ x: 20 * MINUTE, a: RUNTIME }, ['a'], 'x');

		expect((await result)?.Media?.[0].duration).toBe(RUNTIME);
		expect(pmsService.removeMapping).toHaveBeenCalledTimes(1);
		expect(pmsService.addStream.mock.calls.map(([, url]) => url)).toEqual(['a']);
	});

	it('returns null without touching Plex when the item has no Stremio id', async () => {
		const pmsService = plexFake({});
		const stremioService = { streamCandidates: vi.fn(async () => null) };
		const appService = new AppService(stremioService as any, pmsService as any);

		expect(await appService.resolveMedia(movie)).toBeNull();
		expect(pmsService.addStream).not.toHaveBeenCalled();
	});
});
