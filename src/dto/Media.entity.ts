import { Expose, Type } from 'class-transformer';
import { Part } from './Part.entity.js';
import fluentFfmpeg from 'fluent-ffmpeg';
import { generateHash } from '../utils/generic.js';

@Expose()
export class Media {
	id: number;
	duration: number; //In milliseconds?
	bitrate: number; //In kilobits per second
	width: number;
	height: number;
	aspectRatio: number; // width divided by height
	audioChannels: number;
	videoCodec: string; //Codec name eg. h264, hevc, av1
	audioCodec: string; //Codec name eg. aac, opus, etc
	videoResolution: string; //I think this might require some more refined logic as it might be used for bitrate targets. So it needs a standard value of 1080, 480, 360, etc.
	container: string; //Container, eg. mp4, mkv, etc
	videoFrameRate: string; //Frame rate, eg. 'NTSC'
	videoProfile: string; //Video encoding profile, eg 'high'
	hasVoiceActivity: boolean; //Not sure?
	audioProfile: string;
	optimizedForStreaming: boolean;
	selected: boolean;

	protocol: string; //'hls' or 'dash'?

	// Live TV fields
	beginsAt?: number; // Unix timestamp — live broadcast start
	endsAt?: number; // Unix timestamp — live broadcast end
	onAir?: boolean;
	premiere?: boolean;
	origin?: string; // e.g. 'livetv'
	channelTitle?: string;
	channelSlug?: string;
	channelIdentifier?: string;
	channelPoster?: string; // URL
	channelArt?: string; // URL

	@Type(() => Part)
	Part: Part[] = [];

	constructor(
		id: string,
		metadata: fluentFfmpeg.FfprobeData,
		mediaChoices: { audioStreamID?: number; subtitleStreamID?: number },
		transcode: boolean = false,
		direct: boolean = false,
	) {
		const videoStream = metadata.streams.find((stream) => stream.codec_type == 'video');
		const audioStream = metadata.streams.find((stream) => stream.codec_type == 'audio');
		const bitRate = metadata.format.bit_rate;
		const bitrate =
			typeof bitRate === 'number'
				? Math.round(bitRate / 1000)
				: typeof bitRate === 'string' && bitRate !== 'N/A'
					? Math.round(Number.parseInt(bitRate, 10) / 1000)
					: 8000;

		Object.assign(this, {
			id: generateHash(id),
			duration: metadata.format.duration ? metadata.format.duration * 1000 : 0,
			bitrate,
			width: videoStream?.width,
			height: videoStream?.height,
			aspectRatio: videoStream?.width && videoStream?.height ? Math.round(videoStream.width / videoStream.height) : undefined,
			audioChannels: audioStream?.channels,
			audioCodec: audioStream?.codec_name,
			videoCodec: videoStream?.codec_name,
			// videoCodec: 'h264',
			// audioCodec: 'aac',
			videoResolution: videoStream ? `${videoStream.height}` : undefined, //I think this might require some more refined logic as it might be used for bitrate targets. So it needs a standard value of 1080, 480, 360, etc.
			// "videoResolution": "480",
			container: 'mkv', //Maybe?
			videoFrameRate: 'NTSC',
			videoProfile: 'main 10',
			hasVoiceActivity: false,
		});

		if (transcode) {
			this.protocol = 'hls';
			this.container = 'mpegts';
			this.selected = true;
			this.optimizedForStreaming = true;
		}

		this.Part.push(new Part(id, metadata, mediaChoices, transcode, direct));
	}
}
