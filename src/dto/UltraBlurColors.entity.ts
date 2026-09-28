import { Expose } from 'class-transformer';

@Expose()
export class UltraBlurColors {
	topLeft: string;
	topRight: string;
	bottomRight: string;
	bottomLeft: string;

	constructor(values: Partial<UltraBlurColors>) {
		Object.assign(this, values);
	}
}
