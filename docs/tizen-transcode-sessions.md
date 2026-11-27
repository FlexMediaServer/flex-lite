# Tizen transcode sessions

Reference for how Tizen's DASH player starts transcodes through Flex.

## The behaviour

1. The client calls `/video/:/transcode/universal/start.mpd` with the full set of parameters: `path`, `session`, `mediaIndex`, `partIndex`, `protocol=dash`, `directStream`, `videoResolution`, the `X-Plex-*` client identity, and so on.
2. Later, the DASH player calls the same route again with only `session=<id>`. It sends no `path`, no client parameters and no token.
3. Plex rejects a bare session call. If it has no stored parameters for the session, it answers `400` with `Unable to find client profile for device` or `unable to find a matching profile`.

## What Flex does

`src/play-queues/play-queues.controller.ts`, `start()`:

- A call with `path` resolves the Flex item to its local Plex key, then stores the query Plex will see under the session id (`rememberTranscodeStart`, `src/play-queues/transcode-sessions.ts`).
- A call with only `session` gets the stored query merged underneath its own parameters (`transcodeStartOf`) before it goes to Plex.
- A session id Flex has never seen is forwarded unchanged, as before.

The store is in memory with a 24 hour TTL. A Flex restart in the middle of playback loses it, and the retry falls back to the bare request.

`LoggedInGuard` lets any `/universal/start` call with a `session` query through without a Plex login, so the bare retry needs no auth.

## What a test showed

Against a live Plex server, using the Flex item guid of a local H.264 MKV:

| Request | Plex saw | Result |
| --- | --- | --- |
| Full start with `path` | `path=/library/metadata/<local key>` plus the parameters | 200, DASH MPD |
| Bare retry, same session | `path` and parameters replayed from the store | 200, DASH MPD |
| Bare retry, unknown session | `session` and the token only | 400, no matching profile (the reported bug) |

Plex only returned 200 once the first call carried a transcode profile. The client-identity headers were not enough on their own.