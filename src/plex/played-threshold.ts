//Plex's default: an item counts as watched once 90% of it has played
export const DEFAULT_PLAYED_THRESHOLD = 0.9;

//The server preference behind "Video played threshold" in Settings
const PLAYED_THRESHOLD_ID = 'LibraryVideoPlayedThreshold';

//The server's "video played threshold" preference, as a fraction of the item. Falls back to the default when it is missing or unusable.
export function playedThresholdFrom(settings: Array<{ id?: string; label?: string; value?: string | number }> | undefined): number {
	const setting = settings?.find((entry) => entry.id === PLAYED_THRESHOLD_ID) ?? settings?.find((entry) => /video played threshold/i.test(entry.label ?? ''));
	const percent = parseInt(String(setting?.value ?? ''), 10);

	return percent >= 1 && percent <= 100 ? percent / 100 : DEFAULT_PLAYED_THRESHOLD;
}

//Both times are in milliseconds, as Plex reports them
export function reachedPlayedThreshold(viewOffset: number, duration: number | undefined, threshold: number): boolean {
	return !!duration && viewOffset >= duration * threshold;
}
