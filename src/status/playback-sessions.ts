export type PlaybackUser = { id?: number; title?: string; thumb?: string };

const TTL_MS = 24 * 3600 * 1000;
const PRUNE_EVERY_MS = 60 * 1000;

//Kept here rather than in the shared cache: Keyv only drops an expired entry when that key is read again,
//so a session that is never read again would stay in memory. This map is pruned as it grows.
const sessions = new Map<string, { user: PlaybackUser; expiresAt: number }>();
let prunedAt = 0;

function prune(now: number) {
	if (now - prunedAt < PRUNE_EVERY_MS) return;

	prunedAt = now;
	for (const [playbackSessionId, session] of sessions) {
		if (session.expiresAt <= now) sessions.delete(playbackSessionId);
	}
}

//Plex reports every playback Flex serves under the owner's account, so the real viewer is kept from the timeline calls
export function rememberPlaybackUser(playbackSessionId: string | undefined, user: PlaybackUser | undefined): void {
	if (!playbackSessionId || !user?.id) return;

	const now = Date.now();
	prune(now);
	sessions.set(playbackSessionId, { user: { id: user.id, title: user.title, thumb: user.thumb }, expiresAt: now + TTL_MS });
}

//Sessions currently held, including ones that have expired but not yet been pruned
export function trackedSessionCount(): number {
	return sessions.size;
}

export function playbackUserOf(playbackSessionId: string | undefined): PlaybackUser | undefined {
	if (!playbackSessionId) return undefined;

	const session = sessions.get(playbackSessionId);
	if (!session) return undefined;

	if (session.expiresAt <= Date.now()) {
		sessions.delete(playbackSessionId);
		return undefined;
	}

	return session.user;
}
