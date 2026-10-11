import { describe, expect, it } from 'vitest';
import { extractItemIds, isLocalId } from './item-id.js';

describe('isLocalId', () => {
	it('treats integer ratingKeys as local and Discover hex ids as not', () => {
		expect(isLocalId('435070')).toBe(true);
		expect(isLocalId('68ec89c449b9526d4b7250a3')).toBe(false);
	});
});

describe('extractItemIds', () => {
	it('reads ids from the metadata path, including comma lists', () => {
		expect(extractItemIds('/library/metadata/1,2/children')).toEqual(['1', '2']);
	});

	it('reads ids from item params, including raw scrobble keys and uris', () => {
		expect(extractItemIds('/:/scrobble', { key: '435070' })).toEqual(['435070']);
		expect(extractItemIds('/:/timeline', { key: '/library/metadata/12' })).toEqual(['12']);
		expect(extractItemIds('/playQueues', { uri: 'library://x/item//library/metadata/9' })).toEqual(['9']);
	});

	it('returns nothing for routes without items', () => {
		expect(extractItemIds('/hubs/promoted', { contentDirectoryID: '1' })).toEqual([]);
	});
});
