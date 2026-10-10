//URL of the video played when nothing resolves. Defaults to the Flex server inside the unified container, since Plex ingests it from localhost.
export function getMediaNotFoundUrl (): string {
	if (process.env.MEDIA_NOT_FOUND_VIDEO) return process.env.MEDIA_NOT_FOUND_VIDEO;
	const port = process.env.FLEX_PORT ?? 32404;
	return `http://localhost:${port}/assets/MediaNotFound.mp4`;
}
