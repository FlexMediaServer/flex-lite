import { Expose } from 'class-transformer';

@Expose()
export class Image {
	alt: string;
	type: string;
	url: string;

	constructor(values: Partial<Image>) {
		Object.assign(this, values);
	}
}
