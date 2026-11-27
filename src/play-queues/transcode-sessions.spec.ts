import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const DAY = 24 * 3600 * 1000;

//Each test loads a fresh module, since the starts map is shared module state
let store: typeof import('./transcode-sessions.js');

describe('transcode sessions', () => {
	beforeEach(async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-11-26T12:00:00Z'));
		vi.resetModules();
		store = await import('./transcode-sessions.js');
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('returns the parameters a session was started with', () => {
		store.rememberTranscodeStart('session-a', { path: '/library/metadata/5', offset: '0', session: 'session-a' });

		expect(store.transcodeStartOf('session-a')).toEqual({ path: '/library/metadata/5', offset: '0', session: 'session-a' });
		expect(store.transcodeStartOf('unknown')).toBeUndefined();
	});

	it('keeps a copy, so later changes to the query do not leak in', () => {
		const query: Record<string, string> = { path: '/library/metadata/5' };
		store.rememberTranscodeStart('session-b', query);
		query.path = '/library/metadata/9';

		expect(store.transcodeStartOf('session-b')).toEqual({ path: '/library/metadata/5' });
	});

	it('ignores requests without a session id', () => {
		store.rememberTranscodeStart(undefined, { path: '/library/metadata/5' });

		expect(store.transcodeStartOf(undefined)).toBeUndefined();
	});

	it('forgets a session after its ttl', () => {
		store.rememberTranscodeStart('session-c', { path: '/library/metadata/5' });

		vi.setSystemTime(Date.now() + DAY + 1);

		expect(store.transcodeStartOf('session-c')).toBeUndefined();
	});
});
