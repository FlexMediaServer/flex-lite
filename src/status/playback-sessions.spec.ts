import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const DAY = 24 * 3600 * 1000;

//Each test loads a fresh module, since the sessions map is shared module state
let store: typeof import('./playback-sessions.js');

describe('playback sessions', () => {
	beforeEach(async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-10-11T12:00:00Z'));
		vi.resetModules();
		store = await import('./playback-sessions.js');
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('returns the viewer recorded for a playback session', () => {
		store.rememberPlaybackUser('session-a', { id: 7, title: 'Sam', thumb: 'sam.png' });

		expect(store.playbackUserOf('session-a')).toEqual({ id: 7, title: 'Sam', thumb: 'sam.png' });
		expect(store.playbackUserOf('unknown')).toBeUndefined();
	});

	it('ignores timelines without a session id or a user', () => {
		store.rememberPlaybackUser(undefined, { id: 7 });
		store.rememberPlaybackUser('session-b', undefined);

		expect(store.trackedSessionCount()).toBe(0);
	});

	it('forgets a session a day after it was last reported', () => {
		store.rememberPlaybackUser('session-c', { id: 7, title: 'Sam' });
		vi.setSystemTime(Date.now() + DAY + 1);

		expect(store.playbackUserOf('session-c')).toBeUndefined();
	});

	it('keeps a session alive while its timelines keep arriving', () => {
		store.rememberPlaybackUser('session-d', { id: 7, title: 'Sam' });
		vi.setSystemTime(Date.now() + DAY - 1000);
		store.rememberPlaybackUser('session-d', { id: 7, title: 'Sam' });
		vi.setSystemTime(Date.now() + DAY - 1000);

		expect(store.playbackUserOf('session-d')).toEqual({ id: 7, title: 'Sam', thumb: undefined });
	});

	it('prunes expired sessions on later writes, so they do not pile up', () => {
		store.rememberPlaybackUser('session-e', { id: 7, title: 'Sam' });
		vi.setSystemTime(Date.now() + DAY + 1);

		//The first write after the prune interval sweeps out everything already expired
		store.rememberPlaybackUser('session-f', { id: 8, title: 'Ana' });
		expect(store.trackedSessionCount()).toBe(1);

		vi.setSystemTime(Date.now() + 61 * 1000);
		store.rememberPlaybackUser('session-g', { id: 9, title: 'Lee' });

		expect(store.trackedSessionCount()).toBe(2);
		expect(store.playbackUserOf('session-g')).toEqual({ id: 9, title: 'Lee', thumb: undefined });
	});
});
