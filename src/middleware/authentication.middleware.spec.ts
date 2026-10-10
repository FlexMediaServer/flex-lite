import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ofetch } from 'ofetch';
import { AuthenticationMiddleware } from './authentication.middleware.js';

vi.mock('ofetch', () => ({ ofetch: vi.fn() }));
vi.mock('../plex/plex.service.js', () => ({ PMSService: class {} }));

const OWNER = { id: 1, token: 'owner-token', type: 'device' };
const FRIEND = { id: 2, token: 'friend-token', type: 'invited-user', invited: { id: 42, username: 'friend' } };

describe('AuthenticationMiddleware', () => {
	let accessTokens: any[];
	let middleware: AuthenticationMiddleware;

	const accessTokenCalls = () => vi.mocked(ofetch).mock.calls.filter(([url]) => String(url).includes('access_tokens')).length;

	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-10-10T12:00:00Z'));
		vi.clearAllMocks();

		accessTokens = [OWNER];
		vi.mocked(ofetch).mockImplementation((async (url: string) => {
			if (url.includes('access_tokens')) return accessTokens;
			if (url.includes('/api/v2/user')) return { id: 1, username: 'owner' };
			throw new Error(`Unexpected request: ${url}`);
		}) as any);

		middleware = new AuthenticationMiddleware({ plexToken: 'owner-token' } as any);
	});

	it('accepts a friend shared while the access token list is still cached', async () => {
		await middleware.getSession(OWNER.token);

		//Friend is shared 10s later, still inside the 30s cache TTL
		vi.advanceTimersByTime(10_000);
		accessTokens = [OWNER, FRIEND];

		expect(await middleware.getSession(FRIEND.token)).toEqual(FRIEND.invited);
	});

	it('does not refetch the access token list for every unknown token', async () => {
		await middleware.getSession(OWNER.token);
		vi.advanceTimersByTime(10_000);

		await middleware.getSession('random-1');
		const callsAfterFirstMiss = accessTokenCalls();

		await middleware.getSession('random-2');
		expect(accessTokenCalls()).toBe(callsAfterFirstMiss);
	});

	it('does not block a token for long after it was missing', async () => {
		await middleware.getSession(OWNER.token);
		vi.advanceTimersByTime(10_000);

		expect(await middleware.getSession(FRIEND.token)).toBeUndefined();

		//Shared right after the rejected request, so the next attempt should succeed once the block expires
		accessTokens = [OWNER, FRIEND];
		vi.advanceTimersByTime(11_000);

		expect(await middleware.getSession(FRIEND.token)).toEqual(FRIEND.invited);
	});
});
