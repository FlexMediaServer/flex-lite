import { describe, expect, it, vi } from 'vitest';
import { ClientIdentifier, ClientType } from './client-identifier.middleware.js';

//Only the parts of the request the middleware reads are faked
function identify(headers: Record<string, string>, query: Record<string, string> = {}) {
	const req: any = {
		get: (name: string) => headers[name.toLowerCase()],
		query,
	};
	new ClientIdentifier().use(req, {} as any, vi.fn());
	return req.clientType as ClientType;
}

const CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';

describe('ClientIdentifier', () => {
	it('detects Plezy from the x-plex-platform header, whatever its user agent', () => {
		expect(identify({ 'x-plex-product': 'Plezy', 'user-agent': CHROME })).toBe(ClientType.PLEZY);
		expect(identify({ 'x-plex-product': 'plezy' })).toBe(ClientType.PLEZY);
	});

	it('detects Plezy from a query param when no header carries it', () => {
		expect(identify({ 'user-agent': CHROME }, { 'X-Plex-Product': 'Plezy' })).toBe(ClientType.PLEZY);
	});

	it('keeps the user agent detection for other clients', () => {
		expect(identify({ 'user-agent': 'Roku/DVP-15.2 (15.2.4.3455-E6)' })).toBe(ClientType.ROKU);
		expect(identify({ 'x-plex-platform': 'Roku', 'user-agent': CHROME })).toBe(ClientType.WEB);
	});
});
