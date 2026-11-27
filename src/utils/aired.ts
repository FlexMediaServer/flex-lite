import type { Metadata } from '../dto/Metadata.entity.js';

//Items with no air date, or one whose date has passed, are visible. Future releases stay hidden until their date.
export function hasAired(item: Metadata): boolean {
	return !item.originallyAvailableAt || new Date(item.originallyAvailableAt.replaceAll('-', '/')) <= new Date();
}

//Index of the first aired item at or after `from`, or -1 when none is
export function firstAiredIndex(items: Metadata[], from = 0): number {
	for (let index = from; index < items.length; index++) {
		if (hasAired(items[index])) return index;
	}

	return -1;
}
