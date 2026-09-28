import { Expose, Type } from 'class-transformer';
import { Pivot } from './Pivot.entity.js';

@Expose()
export class Directory {
	context: string; //Default pivot eg. "1.recommended"

	icon: 'https://provider-static.plex.tv/icons/vod-560.svg';
	id: string; //"1"
	uuid: string; //UUID

	agent: 'tv.plex.agents.movie' | 'tv.plex.agents.series';
	language: 'en-US' = 'en-US';

	key: string; //Used as the base path for actions on the directory eg. "/library/sections/1"
	hubKey: string; //Default hub section path

	title: string;
	type: 'movie' | 'show' | 'mixed';

	@Type(() => Pivot)
	Pivot: Pivot[];

	constructor(values: Partial<Directory>) {
		Object.assign(this, values);
	}
}
