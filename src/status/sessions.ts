import type { Metadata } from '../dto/Metadata.entity.js';
import type { PlaybackUser } from './playback-sessions.js';

const VIRTUAL_LABEL = ' (Virtual)';

//Every Flex-served item is virtual. Its show title (or its own title, for a movie) carries the label in Now Playing.
function labelVirtual(item: Metadata): Metadata {
	if (item.type === 'episode' && item.grandparentTitle) return { ...item, grandparentTitle: `${item.grandparentTitle}${VIRTUAL_LABEL}` };

	return { ...item, title: `${item.title}${VIRTUAL_LABEL}` };
}

//Now Playing shows a Flex-served item as its Plex copy under the owner. Flex's item and the real viewer replace those,
//and the playback state (progress, player, media) stays as Plex reports it.
export function rewriteSession(session: any, flexItem: Metadata | undefined, viewer: PlaybackUser | undefined): any {
	if (!flexItem) return session;

	return {
		...labelVirtual(flexItem),
		sessionKey: session.sessionKey,
		viewOffset: session.viewOffset,
		Media: session.Media,
		Player: session.Player,
		Session: session.Session,
		User: viewer ? { id: viewer.id, title: viewer.title, thumb: viewer.thumb } : session.User,
	};
}
