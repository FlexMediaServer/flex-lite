import { Expose } from 'class-transformer';

@Expose()
export class Action {
	id: 'removeFromContinueWatching'; //eg. removeFromContinueWatching
	key: string; //eg. /actions/removeFromContinueWatching

	constructor(values: Partial<Action>) {
		Object.assign(this, values);
	}
}
