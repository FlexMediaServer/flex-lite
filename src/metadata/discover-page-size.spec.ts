import { describe, expect, it } from 'vitest';
import { discoverPageSize } from './discover-page-size.js';

describe('discoverPageSize', () => {
	it('caps grandchildren pages at 100, the largest size Discover accepts', () => {
		expect(discoverPageSize('grandchildren', '200')).toBe(100);
		expect(discoverPageSize('grandchildren', 101)).toBe(100);
		expect(discoverPageSize('grandchildren', 50)).toBe(50);
	});

	it('leaves children pages alone', () => {
		expect(discoverPageSize('children', '200')).toBe(200);
	});

	it('defaults to 100 when no size is requested', () => {
		expect(discoverPageSize('children', undefined)).toBe(100);
		expect(discoverPageSize('grandchildren', '')).toBe(100);
	});
});
