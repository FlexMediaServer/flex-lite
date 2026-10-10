import { FfprobeData } from "fluent-ffmpeg";
import { Media } from "../dto/Media.entity.js";
import { MediaContainer } from "../dto/MediaContainer.entity.js";
import { Metadata } from "../dto/Metadata.entity.js";
import { PlayQueue } from "../play-queues/play-queues.service.js";

export function emptyMedia(id = "empty") {
	return {
		id: id,
		// container: 'mp4',
		// protocol: 'hls',
		Part: [
			{
				id: id,
				key: `/resolve/${id}`,
				// container: 'mp4',
				exists: true,
				accessible: true,
				Stream: [],
			},
		],
	};
}

export async function serializePlayQueues(playQueue: PlayQueue, window: { items: Metadata[]; totalSize: number }, isXML: boolean = false) {
	const currentItem = window.items.find((item) => item.guid == playQueue.currentItem || item.ratingKey == playQueue.currentItem);

	return {
		MediaContainer: new MediaContainer({
			identifier: 'com.plexapp.plugins.library',
			mediaTagPrefix: '/system/bundle/media/flags/',
			mediaTagVersion: 1732215884,
			playQueueID: playQueue.id?.toString(),
			playQueueSelectedItemID: playQueue.currentItem.split('/').pop(),
			playQueueSelectedItemOffset: 0,
			playQueueSelectedMetadataItemID: currentItem?.ratingKey,
			playQueueShuffled: false,
			playQueueSourceURI: `library://x/item/%2Flibrary%2Fmetadata%2F${currentItem?.ratingKey}`,
			playQueueTotalCount: window.totalSize,
			playQueueVersion: 1,
			[isXML ? 'Video' : 'Metadata']: window.items.map((item) => new Metadata({
				// playQueueItemID: index + offset,
				playQueueItemID: item.ratingKey,
				...item
			})),
		})
	}
}