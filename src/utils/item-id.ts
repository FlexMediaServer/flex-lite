import { parseKey } from './generic.js';

//Local ids are real Plex ratingKeys (integers). Flex's own ids are Plex Discover ids (24-character hex).
export const isLocalId = (id: string) => /^\d{1,15}$/.test(id);

//Item ids a request refers to: the /library/metadata/<ids> path, or the key/path/uri params of item routes.
export function extractItemIds(path: string, query: Record<string, any> = {}): string[] {
	const values = [path, query.key, query.path, query.uri].filter((value): value is string => typeof value === 'string');

	return values
		.flatMap((value) => {
			if (/^[\d,]+$/.test(value)) return value.split(','); //Raw id, eg. scrobble key
			if (!value.includes('/metadata/')) return [];
			return parseKey(value).itemId?.split(',') ?? [];
		})
		.filter(Boolean);
}
