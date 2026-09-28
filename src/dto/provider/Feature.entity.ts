import { Expose, Type } from 'class-transformer';
import { Directory } from './Directory.entity.js';
import { Action } from './Action.entity.js';

@Expose()
export class Feature {
	@Type(() => Directory)
	Directory: Directory[];

	key: string; //eg. "/library/sections"
	type:
		| 'content'
		| 'search'
		| 'match'
		| 'metadata'
		| 'continuewatching'
		| 'imagetranscoder'
		| 'promoted'
		| 'rate'
		| 'playqueue'
		| 'playlist'
		| 'collection'
		| 'actions'
		| 'timeline'
		| 'manage'
		| 'queryParser'
		| 'subscribe'
		| 'universalsearch'
		| 'collection'
		| 'grid'
		| 'settings';

	flavor: 'universal' | 'download';

	//Type: timeline
	scrobbleKey?: string; //eg. /:/scrobble
	unscrobbleKey?: string; //eg. /:/unscrobble
	//End

	//Type: actions
	@Type(() => Action)
	Action?: Action[];
	//End

	constructor(values: Partial<Feature>) {
		Object.assign(this, values);
	}
}
