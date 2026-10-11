import type { SectionsService } from '../plex/sections.service.js';
import { extractItemIds, isLocalId } from './item-id.js';

export type ProxyState = {
	proxyEnabled: boolean;
	sections: Pick<SectionsService, 'enabled' | 'isVirtual'>;
	playQueueMissing?: boolean; //Play queue is not held by Flex, so it belongs to Plex
};

//Routes Flex serves once it has a Plex token. Everything not listed here is proxied straight to Plex.
const FLEX_ROUTES = [
	'/library/all',
	'/library/parts',
	'/:/timeline',
	'/:/scrobble',
	'/:/unscrobble',
	'/video/:/transcode/universal/decision',
	'/video/:/transcode/universal/start',
	'/media/providers',
	'/library/metadata',
	'/playQueues',
	'/dummy.mkv',
	'/actions/removeFromContinueWatching',
];

//true: proxy to Plex. false: Flex handles the request.
export function shouldProxy(path: string, query: Record<string, any>, state: ProxyState): boolean {
	if (path.startsWith('/assets/MediaNotFound.mp4') || path.startsWith('/resolve/')) return false; //Flex's own files
	if (!state.proxyEnabled) return true;

	//Requests that only name local Plex ids go straight to Plex, with the client's own token
	const ids = extractItemIds(path, query);
	if (ids.length && ids.every(isLocalId)) return true;

	//Section overrides: Flex serves its items for virtual sections, Plex serves the rest
	const override = /^\/(?:library\/sections\/([^/]+)\/(?:all|recentlyAdded)|hubs\/sections\/([^/]+))$/.exec(path);
	if (override) return !state.sections.isVirtual(override[1] ?? override[2]);

	if (path.startsWith('/hubs') || path.startsWith('/library/search')) return !state.sections.enabled;
	if (state.playQueueMissing && /^\/playQueues\/\d+/.test(path)) return true;

	return !FLEX_ROUTES.some((route) => path.startsWith(route));
}
