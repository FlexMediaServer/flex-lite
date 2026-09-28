import { Expose, Transform, Type } from 'class-transformer';

@Expose()
export class Rating {
	image: string;
	@Type(() => Number)
	@Transform(({ value }) => (value ? Number.parseInt(value) : 0))
	value: number;
	type: string;

	constructor(values: Partial<Rating>) {
		Object.assign(this, values);
	}
}
