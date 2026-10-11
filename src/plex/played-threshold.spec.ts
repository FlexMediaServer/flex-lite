import { describe, expect, it } from 'vitest';
import { DEFAULT_PLAYED_THRESHOLD, playedThresholdFrom, reachedPlayedThreshold } from './played-threshold.js';

//Entries as /:/prefs reports them on the server
const threshold = { id: 'LibraryVideoPlayedThreshold', label: 'Video played threshold', type: 'int', value: 90 };
const behaviour = { id: 'LibraryVideoPlayedAtBehaviour', label: 'Video play completion behaviour', type: 'text', value: '3' };

describe('playedThresholdFrom', () => {
	it('reads the threshold from the server settings, not the completion behaviour', () => {
		expect(playedThresholdFrom([behaviour, threshold])).toBe(0.9);
	});

	it('uses the value the server reports', () => {
		expect(playedThresholdFrom([{ ...threshold, value: 85 }])).toBe(0.85);
	});

	it('finds the setting by its label when the id differs', () => {
		expect(playedThresholdFrom([{ id: 'Other', label: 'Video played threshold', value: '80' }])).toBe(0.8);
	});

	it('falls back to 90% when the setting is missing or out of range', () => {
		expect(playedThresholdFrom(undefined)).toBe(DEFAULT_PLAYED_THRESHOLD);
		expect(playedThresholdFrom([behaviour])).toBe(DEFAULT_PLAYED_THRESHOLD);
		expect(playedThresholdFrom([{ ...threshold, value: '' }])).toBe(DEFAULT_PLAYED_THRESHOLD);
		expect(playedThresholdFrom([{ ...threshold, value: 0 }])).toBe(DEFAULT_PLAYED_THRESHOLD);
		expect(playedThresholdFrom([{ ...threshold, value: 150 }])).toBe(DEFAULT_PLAYED_THRESHOLD);
	});
});

describe('reachedPlayedThreshold', () => {
	it('is reached once the offset passes the threshold share of the duration', () => {
		expect(reachedPlayedThreshold(89_000, 100_000, 0.9)).toBe(false);
		expect(reachedPlayedThreshold(90_000, 100_000, 0.9)).toBe(true);
	});

	it('is never reached without a known duration', () => {
		expect(reachedPlayedThreshold(999_999, undefined, 0.9)).toBe(false);
	});
});
