import { describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
	process.env.DATABASE_URL = 'sqlite://:memory:';
});

//main.ts bootstraps the server on import, so only its PROXY flag is needed here
vi.mock('../main.js', () => ({ PROXY: { enabled: false } }));
//The stream is not under test here, only the query Plex is called with
vi.mock('../utils/upstream-stream.js', () => ({ streamUpstream: vi.fn(), cancelUnreadBody: vi.fn() }));

const { PlayQueuesController, playbackSessionIdOf } = await import('./play-queues.controller.js');

describe('playbackSessionIdOf', () => {
	it('reads each supported header name', () => {
		expect(playbackSessionIdOf({ 'x-plex-playback-session-id': 'a' })).toBe('a');
		expect(playbackSessionIdOf({ 'x-plex-session-identifier': 'b' })).toBe('b');
		expect(playbackSessionIdOf({ 'x-plex-session-id': 'c' })).toBe('c');
	});

	it('prefers the playback session header over the others', () => {
		expect(playbackSessionIdOf({ 'x-plex-session-id': 'c', 'x-plex-playback-session-id': 'a' })).toBe('a');
	});

	it('reads the id from a query param when no header carries it', () => {
		expect(playbackSessionIdOf({}, { 'X-Plex-Session-Identifier': 'q' })).toBe('q');
	});

	it('returns undefined when the client sends no session id', () => {
		expect(playbackSessionIdOf({}, { type: 'video', uri: 'server://x' })).toBeUndefined();
	});
});

describe('transcode start', () => {
	function setup() {
		const pmsService = {
			resolveLocalItem: vi.fn(async () => [{ key: '/library/metadata/555' }]),
			plexServerApi: { raw: vi.fn(async () => ({ headers: new Headers(), _data: undefined })) },
		};
		const metadataService = { getItem: vi.fn(async () => ({ guid: 'flex-item' })) };
		const controller = new PlayQueuesController({} as any, metadataService as any, {} as any, pmsService as any, {} as any, {} as any);
		const req = { path: '/video/:/transcode/universal/start.mpd', baseUrl: '' };
		return { controller, pmsService, req };
	}

	it('calls Plex with the local item path and the session parameters', async () => {
		const { controller, pmsService, req } = setup();

		await controller.start(req, {}, { path: '/library/metadata/flex-item', session: 'abc', offset: '0' }, {});

		expect(pmsService.plexServerApi.raw).toHaveBeenCalledWith(
			'/video/:/transcode/universal/start.mpd',
			expect.objectContaining({ query: expect.objectContaining({ path: '/library/metadata/555', session: 'abc', offset: '0' }) }),
		);
	});

	it('replays the start parameters when a session id is sent alone', async () => {
		const { controller, pmsService, req } = setup();

		await controller.start(req, {}, { path: '/library/metadata/flex-item', session: 'replay-1', offset: '0', protocol: 'dash' }, {});
		await controller.start(req, {}, { session: 'replay-1' }, {});

		const [, options] = pmsService.plexServerApi.raw.mock.calls[1] as any;
		expect(options.query).toEqual({ path: '/library/metadata/555', session: 'replay-1', offset: '0', protocol: 'dash' });
	});
});

describe('play queue release dates', () => {
	const aired = { guid: 'plex://episode/1', ratingKey: '1', type: 'episode' };
	const unaired = { guid: 'plex://episode/2', ratingKey: '2', type: 'episode', originallyAvailableAt: '2999-01-01' };

	it('leaves unaired episodes out of the play queue response', async () => {
		const playQueuesService = {
			getPlayQueue: vi.fn(async () => ({ id: 1, playbackSessionId: 's', item: 'plex://show/9', currentItem: 'plex://episode/1', offset: 0 })),
			fetchWindow: vi.fn(async () => ({ items: [aired, unaired], totalSize: 2 })),
		};
		const appService = { resolveMedia: vi.fn(async () => ({ Media: [{}] })) };
		const controller = new PlayQueuesController(appService as any, {} as any, {} as any, {} as any, {} as any, playQueuesService as any);

		const response: any = await controller.getPlayQueues(1, undefined);

		expect(response.MediaContainer.Metadata.map((item: any) => item.ratingKey)).toEqual(['1']);
	});

	it('refuses an episode that has not aired yet', async () => {
		const metadataService = { getItem: vi.fn(async () => unaired) };
		const controller = new PlayQueuesController({} as any, metadataService as any, {} as any, {} as any, {} as any, {} as any);

		await expect(controller.playQueues({ key: '/library/metadata/2' }, {}, {} as any)).rejects.toThrow('has not aired');
	});
});
