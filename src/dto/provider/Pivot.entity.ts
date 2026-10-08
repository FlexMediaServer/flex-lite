import { Expose } from 'class-transformer';

@Expose()
export class Pivot {
	context: string; //eg. "content.discover".
	key: string;
	id: string;
	title: string;
	symbol: 'star' | 'stack';
	type: 'list' | 'hub';

	constructor(values: Partial<Pivot>) {
		Object.assign(this, values);
	}
}
