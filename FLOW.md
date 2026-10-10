# Flex Architecture

Flex is a middleware that sits in front of a Plex Media Server. It serves the library API itself and uses Plex's discovery API as the source of metadata. Playback is backed by streams from Stremio addons, which Flex ingests into the local Plex library on demand.

## Architecture Overview
Flex implements just-in-time importing and playback orchestration on a real Plex server, so every Plex client app works without modification.

### Metadata Structure
All Plex metadata items contain a `Media` property that holds media metadata, including track information.

### Playback Queue
The `playQueues` API endpoint manages playback queueing for upcoming items. First-party Plex clients consume the metadata returned in this request to initiate playback. When transitioning to the next item, the `playQueues` request is reinvoked, and any updated information in the response is used to start playback.

### Playback Flow
When playback starts, the `playQueues` request is held open until the current item is ready on the Plex server:

1. **Local check**: If Plex still has the item, Flex reuses it. For items ingested through Flex, the stored stream URL must also still respond to a HEAD probe. If it does not, the mapping is removed and the flow continues below.
2. **Stream resolution**: Flex requests the item's streams from the Stremio addon and probes each URL in order. The first one that responds is used. If none respond, the not found placeholder is used: one shared Plex copy of `MEDIA_NOT_FOUND_VIDEO`, ingested once and never matched to a metadata item. Each item maps to that copy, and playback of it records no progress or timeline for the item.
3. **Ingestion via `POST /library/file`**: Flex calls the Plex server's `POST /library/file` endpoint with the stream URL as the `url` query parameter (`ingestNonMatches=1`, `computeHashes=0`). Plex ingests the URL directly and returns the new library item.
4. **Matching**: Flex calls `PUT <item key>/match` with the item's Plex guid and title so the ingested file is attached to the correct metadata.
5. **Mapping**: The Plex guid, the new Plex item ID, and the stream URL are stored in `item_mappings`. Later requests for the same item reuse it, and concurrent requests for the same item share a single ingest.
6. **Queue serialization**: The current play queue item is replaced with the local Plex item and its `Media`. Other items in the queue get empty media. The playQueue is then returned, and the client plays the item through Plex.
