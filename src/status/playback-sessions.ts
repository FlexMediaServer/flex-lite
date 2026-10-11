export type PlaybackUser = { id?: number; title?: string; thumb?: string };

const TTL_MS = 24 * 3600 * 1000;
const PRUNE_EVERY_MS = 60 * 1000;

//Kept here rather than in the shared cache: Keyv only drops an expired entry when that key is read again,
//so a session that is never read again would stay in memory. These maps are pruned as they grow.
const sessions = new Map<string, { user: PlaybackUser; expiresAt: number }>();
//Items already counted as watched in a playback, keyed by playback session and item guid
const watched = new Map<string, number>();
let prunedAt = 0;

function prune(now: number) {
	if (now - prunedAt < PRUNE_EVERY_MS) return;

	prunedAt = now;
	for (const [playbackSessionId, session] of sessions) {
		if (session.expiresAt <= now) sessions.delete(playbackSessionId);
	}
	for (const [key, expiresAt] of watched) {
		if (expiresAt <= now) watched.delete(key);
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

//True once an item has been counted as watched in this playback
export function playbackWatched(playbackSessionId: string, guid: string): boolean {
	return (watched.get(`${playbackSessionId}:${guid}`) ?? 0) > Date.now();
}

//Marks an item as watched in this playback. Returns false when it already was, so it is only counted once.
export function claimPlaybackWatched(playbackSessionId: string, guid: string): boolean {
	const now = Date.now();
	prune(now);

	if (playbackWatched(playbackSessionId, guid)) return false;

	watched.set(`${playbackSessionId}:${guid}`, now + TTL_MS);
	return true;
}
