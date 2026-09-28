import { Expose, Type } from 'class-transformer';
import { Stream } from './Stream.entity.js';
import fluentFfmpeg from 'fluent-ffmpeg';

@Expose()
export class Part {
	id: number;

	audioProfile: string;
	videoProfile: string;
	bitrate: number;
	container: string;
	duration: number; //Duration in milliseconds
	height: number;
	width: number;
	optimizedForStreaming: boolean;
	protocol: 'dash' | 'hls';
	decision?: 'transcode' | 'directplay'; //Only used in decision endpoint
	selected: boolean;

	key: string; //Relative file path key
	file: string; //File path on disk (optional)

	hasThumbnail: boolean;

	size: number; //in kilobytes??
	exists: boolean;
	accessible: boolean;
	rafAdapter?: string; // Rate-adaptive fetching adapter hint, e.g. 'none'

	@Type(() => Stream)
	Stream: Stream[] = [];

	constructor(
		id: string,
		metadata: fluentFfmpeg.FfprobeData,
		mediaChoices: { audioStreamID?: number; subtitleStreamID?: number },
		transcode = false,
		direct = false,
	) {
		Object.assign(this, {
			// id: generateHash(id),
			id,
			key: `/library/parts/${id}/file`,
			duration: metadata.format.duration ? metadata.format.duration * 1000 : 0,
			file: `/library/parts/${id}/file`,
			size: 2160115432,
			audioProfile: 'lc',
			container: 'mp4',
			exists: true,
			accessible: true,
			videoProfile: 'main 10',
		});

		if (transcode) {
			(this.container = 'mpegts'), (this.protocol = 'hls');
			this.decision = 'transcode';
			// this.selected = true;
			this.optimizedForStreaming = true;
		}

		if (direct) {
			this.decision = 'directplay';
		}

		// console.log(metadata.streams);

		this.Stream = metadata.streams
			.filter((stream) => stream.codec_type ? ['video', 'audio', 'subtitle'].includes(stream.codec_type) : false)
			.map((stream) => new Stream(stream, mediaChoices, transcode, direct));
	}
}
