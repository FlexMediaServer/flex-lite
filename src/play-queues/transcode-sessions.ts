const TTL_MS = 24 * 3600 * 1000;
const PRUNE_EVERY_MS = 60 * 1000;

//The parameters each transcode session was started with, as Plex saw them (Flex item paths already resolved to local keys).
//Some clients (eg. Tizen's DASH player) later call the same session with only its session id, so these are replayed from here.
const starts = new Map<string, { query: Record<string, any>; expiresAt: number }>();
let prunedAt = 0;

function prune(now: number) {
	if (now - prunedAt < PRUNE_EVERY_MS) return;

	prunedAt = now;
	for (const [sessionId, start] of starts) {
		if (start.expiresAt <= now) starts.delete(sessionId);
	}
}

export function rememberTranscodeStart(sessionId: string | undefined, query: Record<string, any>): void {
	if (!sessionId) return;

	const now = Date.now();
	prune(now);
	starts.set(sessionId, { query: { ...query }, expiresAt: now + TTL_MS });
}

export function transcodeStartOf(sessionId: string | undefined): Record<string, any> | undefined {
	if (!sessionId) return undefined;

	const start = starts.get(sessionId);
	if (!start) return undefined;

	if (start.expiresAt <= Date.now()) {
		starts.delete(sessionId);
		return undefined;
	}

	return { ...start.query };
}
