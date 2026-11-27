import { describe, expect, it } from 'vitest';
import { withinDurationMargin } from './duration.js';

const MINUTE = 60 * 1000;

describe('withinDurationMargin', () => {
	it('accepts a length that matches the runtime', () => {
		expect(withinDurationMargin(90 * MINUTE, 90 * MINUTE)).toBe(true);
	});

	it('accepts a length within the percentage margin of a long runtime', () => {
		//5% of 120 minutes is 6 minutes
		expect(withinDurationMargin(120 * MINUTE, 114 * MINUTE)).toBe(true);
		expect(withinDurationMargin(120 * MINUTE, 126 * MINUTE)).toBe(true);
	});

	it('rejects a length outside the percentage margin of a long runtime', () => {
		expect(withinDurationMargin(120 * MINUTE, 100 * MINUTE)).toBe(false);
	});

	it('uses the two minute floor for short runtimes', () => {
		//5% of 20 minutes is 1 minute, so the 2 minute floor applies
		expect(withinDurationMargin(20 * MINUTE, 22 * MINUTE)).toBe(true);
		expect(withinDurationMargin(20 * MINUTE, 23 * MINUTE)).toBe(false);
	});

	it('passes when either length is unknown, since it cannot be judged', () => {
		expect(withinDurationMargin(undefined, 90 * MINUTE)).toBe(true);
		expect(withinDurationMargin(90 * MINUTE, 0)).toBe(true);
		expect(withinDurationMargin(null, undefined)).toBe(true);
	});
});
