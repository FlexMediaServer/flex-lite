import { Expose } from 'class-transformer';
import fluentFfmpeg from 'fluent-ffmpeg';
import langs from 'langs';

@Expose()
export class Stream {
	id: number;
	streamType: number; // 1 = video, 2 = audio, 3 = subtitle
	index: number;
	codec: string;
	// codec: 'h264',
	bitrate: number;
	frameRate: number;
	bitDepth: number;
	chromaLocation: string;
	chromaSubsampling: string;
	codedHeight: number;
	codedWidth: number;
	colorPrimaries: string;
	colorRange: string;
	colorSpace: string;
	colorTrc: string;
	default: boolean;
	height: number;
	width: number;
	// level: stream.level,
	profile: string;
	refFrames: number;
	displayTitle: string;
	extendedDisplayTitle: string;
	selected: boolean;

	//Start Decision Endpoint
	decision: 'transcode' | 'directplay';
	location: 'segments-av' | 'direct';
	//End Decision Endpoint

	constructor(
		stream: fluentFfmpeg.FfprobeStream,
		mediaChoices: { audioStreamID?: number; subtitleStreamID?: number },
		transcode: boolean = false,
		direct = false,
	) {
		this.id = stream.index + 1;

		let lang, selected;

		switch (stream.codec_type) {
			case 'video': {
				const fpsParsed = stream.r_frame_rate ? stream.r_frame_rate.split('/') : [];
				const fps = parseInt(fpsParsed[0]) / parseInt(fpsParsed[1]);
				Object.assign(this, {
					streamType: 1,
					index: stream.index,
					codec: stream.codec_name,
					// codec: 'h264',
					bitrate: stream.bit_rate && stream.bit_rate !== 'N/A' ? Math.round(parseInt(stream.bit_rate) / 1000) : 8000,
					frameRate: Math.round(fps),
					bitDepth: 8,
					chromaLocation: stream.chroma_location,
					chromaSubsampling: '4:2:0',
					codedHeight: stream.coded_height,
					codedWidth: stream.coded_width,
					colorPrimaries: stream.color_primaries,
					colorRange: stream.color_range,
					colorSpace: stream.color_space,
					colorTrc: stream.color_transfer,
					default: stream.disposition ? stream.disposition.default ? true : undefined : undefined,
					height: stream.height,
					// level: stream.level,
					profile: 'high',
					// refFrames: stream.refs,
					width: stream.width,
					displayTitle: '1080p (HEVC Main 10)',
					extendedDisplayTitle: '1080p (HEVC Main 10)',
					selected: true,
				});

				if (transcode) {
					this.decision = 'transcode';
					this.location = 'segments-av';
				}

				if (direct) {
					this.decision = 'directplay';
					this.location = 'direct';
				}

				break;
			}
			case 'audio':
				if (mediaChoices?.audioStreamID === undefined && stream.disposition && stream.disposition.default) {
					mediaChoices.audioStreamID = stream.index + 1;
					this.default = true;
				}

				lang = stream.tags?.language ? langs.where('2B', stream.tags.language) || langs.where('2T', stream.tags.language) : undefined;

				selected = mediaChoices?.audioStreamID === this.id;

				Object.assign(this, {
					streamType: 2,
					index: stream.index,
					selected: mediaChoices?.audioStreamID === this.id,
					codec: stream.codec_name,
					channels: stream.channels,
					language: lang?.['name'],
					languageTag: lang?.['1'],
					languageCode: stream.tags?.language ? stream.tags.language : undefined,
					samplingRate: stream.sample_rate,
					title: stream?.tags?.title,
					displayTitle: lang?.['name'],
					extendedDisplayTitle: lang?.['name'],
				});

				if (transcode && selected) {
					this.decision = 'transcode';
					this.location = 'segments-av';
				}
				break;
			case 'subtitle':
				if (mediaChoices?.subtitleStreamID === undefined && stream.disposition && stream.disposition.default) {
					this.default = true;
				}

				lang = stream.tags?.language ? langs.where('2B', stream.tags.language) || langs.where('2T', stream.tags.language) : undefined;

				selected = mediaChoices?.subtitleStreamID === this.id;

				Object.assign(this, {
					streamType: 3,
					canAutoSync: false,
					index: stream.index,
					codec: stream.codec_name,
					selected: mediaChoices?.subtitleStreamID === this.id,
					language: lang?.['name'],
					languageTag: lang?.['1'],
					languageCode: stream.tags?.language,
					title: stream?.tags?.title,
					displayTitle: lang?.['name'],
					extendedDisplayTitle: stream?.tags?.title,
				});

				if (transcode && selected) {
					this.decision = 'transcode';
					this.location = 'segments-av';
				}

				break;
		}
	}
}
