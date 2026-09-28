import { Expose, Type } from 'class-transformer';
import { Feature } from './Feature.entity.js';

@Expose()
export class MediaProvider {
	identifier: string = 'com.plexapp.plugins.library';
	protocols: string = 'stream,download';
	title: string = 'Library';
	types: string = 'video,audio,photo';

	@Type(() => Feature)
	Feature: Feature[];

	constructor(values: Partial<MediaProvider>) {
		Object.assign(this, values);
	}
}
