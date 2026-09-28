Flexio is a middleware that intercepts a Plex Media Server's library API while leveraging Plex's discovery API as it's source for metadata. This architecture enables Plex's first-party metadata integration while providing access to an essentially unlimited media library.

## Architecture Overview
This middleware implements just-in-time content importing and playback orchestration on a real Plex Server, providing a seamless experience for all Plex client applications.

### Metadata Structure
All Plex metadata items contain a `Media` property that holds media metadata, including track information.

### Playback Queue
The `playQueues` API endpoint manages playback queueing for upcoming items. First-party Plex clients consume the metadata returned in this request to initiate playback. When transitioning to the next item, the `playQueues` request is reinvoked, and any updated information in the response is used to start playback.

### Playback Flow
When media playback is initiated, the `playQueues` request on the Plex Media Server API is intentionally stalled until the following sequence completes:

1. **Stream Resolution**: Stream URLs are resolved through the Stremio API
2. **WebDAV Mounting**: Once a working stream is found, the URL is exposed via a WebDAV endpoint, which is mounted to the Plex server using rclone
3. **Library Refresh**: The `/refresh` endpoint is called for the specific folder path containing the media to trigger import into Plex
4. **Import Monitoring**: Flexio monitors for the successful import
5. **Queue Serialization**: Once the content becomes visible in Plex, the playQueue is serialized. Any references to the original file or transcode decisions are internally remapped to the actual Plex server's item ID's
