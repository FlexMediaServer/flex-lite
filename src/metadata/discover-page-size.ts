//Plex Discover answers grandchildren requests with 400 once the page size passes 100. Children accepts larger pages.
export const GRANDCHILDREN_MAX_PAGE_SIZE = 100;

export function discoverPageSize(type: 'children' | 'grandchildren', requested: unknown): number {
	const size = Number(requested) || 100;
	return type === 'grandchildren' ? Math.min(size, GRANDCHILDREN_MAX_PAGE_SIZE) : size;
}
