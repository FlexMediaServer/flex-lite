import { describe, expect, it, vi } from 'vitest';

vi.hoisted(() => {
	process.env.DATABASE_URL = 'sqlite://:memory:';
});

//main.ts bootstraps the server on import, so only its PROXY flag is needed here
vi.mock('../main.js', () => ({ PROXY: { enabled: false } }));

const { playbackSessionIdOf } = await import('./play-queues.controller.js');

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
