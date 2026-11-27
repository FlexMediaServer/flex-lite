//How far a resolved file's length may differ from the item's runtime before its stream is rejected: the larger of the ratio and the floor
export const DURATION_MARGIN_RATIO = 0.05;
export const DURATION_MARGIN_MS = 2 * 60 * 1000;

//True when the two lengths agree within the margin. A length that is unknown on either side can't be judged, so it passes.
export function withinDurationMargin(expectedMs?: number | null, actualMs?: number | null): boolean {
	if (!expectedMs || !actualMs) return true;

	return Math.abs(actualMs - expectedMs) <= Math.max(expectedMs * DURATION_MARGIN_RATIO, DURATION_MARGIN_MS);
}
