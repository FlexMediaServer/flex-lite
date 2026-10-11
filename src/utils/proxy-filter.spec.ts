import { describe, expect, it } from 'vitest';
import { shouldProxy } from './proxy-filter.js';

const withSections = (virtualKeys: string[]) => ({
	enabled: virtualKeys.length > 0,
	isVirtual: (key: string | number | undefined) => virtualKeys.includes(String(key)),
});

const flex = { proxyEnabled: true, sections: withSections(['1', '2']) };
const plexOnly = { proxyEnabled: true, sections: withSections([]) };

describe('shouldProxy', () => {
	it('proxies everything when Flex has no Plex token', () => {
		expect(shouldProxy('/library/metadata/68ec89c449b9526d4b7250a3', {}, { ...flex, proxyEnabled: false })).toBe(true);
	});

	it('keeps Flex-only assets local', () => {
		expect(shouldProxy('/resolve/123', {}, flex)).toBe(false);
		expect(shouldProxy('/assets/MediaNotFound.mp4', {}, flex)).toBe(false);
	});

	it('sends requests that only name local ids to Plex', () => {
		expect(shouldProxy('/library/metadata/435070', {}, flex)).toBe(true);
		expect(shouldProxy('/:/timeline', { key: '/library/metadata/435070' }, flex)).toBe(true);
		expect(shouldProxy('/:/scrobble', { key: '435070' }, flex)).toBe(true);
	});

	it('handles Discover ids, and mixed lists, in Flex', () => {
		expect(shouldProxy('/library/metadata/68ec89c449b9526d4b7250a3', {}, flex)).toBe(false);
		expect(shouldProxy('/library/metadata/435070,68ec89c449b9526d4b7250a3', {}, flex)).toBe(false);
	});

	it('overrides only virtual sections for the section item and hub routes', () => {
		expect(shouldProxy('/library/sections/1/all', {}, flex)).toBe(false);
		expect(shouldProxy('/library/sections/1/recentlyAdded', {}, flex)).toBe(false);
		expect(shouldProxy('/hubs/sections/2', {}, flex)).toBe(false);
		expect(shouldProxy('/library/sections/3/all', {}, flex)).toBe(true);
		expect(shouldProxy('/hubs/sections/3', {}, flex)).toBe(true);
		expect(shouldProxy('/library/sections/1/onDeck', {}, flex)).toBe(true);
	});

	it('merges hubs and search only when virtual sections exist', () => {
		expect(shouldProxy('/hubs/continueWatching', {}, flex)).toBe(false);
		expect(shouldProxy('/hubs/search', {}, flex)).toBe(false);
		expect(shouldProxy('/library/search', {}, flex)).toBe(false);
		expect(shouldProxy('/hubs/continueWatching', {}, plexOnly)).toBe(true);
		expect(shouldProxy('/hubs', {}, plexOnly)).toBe(true);
		expect(shouldProxy('/library/search', {}, plexOnly)).toBe(true);
	});

	it('proxies play queues Flex does not hold', () => {
		expect(shouldProxy('/playQueues/777', {}, { ...flex, playQueueMissing: true })).toBe(true);
		expect(shouldProxy('/playQueues/777', {}, { ...flex, playQueueMissing: false })).toBe(false);
	});
});
