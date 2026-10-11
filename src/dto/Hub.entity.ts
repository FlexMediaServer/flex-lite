import { Exclude, Expose, Type } from 'class-transformer';
import { Metadata } from './Metadata.entity.js';

@Expose()
export class Hub {
	hubKey: string;
	key: string;
	title: string;
	type: 'show' | 'movie' | 'mixed' | 'clip' | 'directory';
	hubIdentifier: string;
	context: string = 'hub.custom.collection';
	more: boolean; //Whether there is more items to load than current size
	placeholder?: boolean; //Whether hub content is deferred (lazy-load shell)
	style?: 'hero' | 'shelf' | 'availabilityPlatforms' | 'button';
	promoted?: boolean; //Whether hub is promoted to user's home page
	autoPreview?: string; //Triggers video preview on hover — typically 'primary'

	@Exclude()
	excludeElements?: string; //Comma-separated list of elements to exclude (e.g., 'Actor,Collection,Country')

	@Type(() => Metadata)
	Metadata?: Metadata[];

	@Type(() => Metadata)
	Video?: Metadata[];

	@Expose()
	get size(): number {
		return (this.Metadata?.length || this.Video?.length) ?? 0;
	}

	constructor(values: Partial<Hub>) {
		//size is derived from the items, and Plex's copy of it would hit the getter-only property
		const fields = { ...values };
		delete fields.size;
		Object.assign(this, fields);
	}
}
