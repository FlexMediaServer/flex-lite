import { Injectable, OnModuleInit } from '@nestjs/common';
import { Metadata } from './dto/Metadata.entity.js';
import { StremioService } from './stremio/stremio.service.js';
import { PMSService } from './plex/plex.service.js';
import { probeUrl } from './utils/probe-url.js';

@Injectable()
export class AppService implements OnModuleInit {

	private readonly tasks = new Map<string, Promise<string | null>>();

	constructor (
		private stremioService: StremioService,
		private pmsService: PMSService,
	) {}

	async onModuleInit () {}

	resolveMedia (item: Metadata): Promise<string | null> {
		const existing = this.tasks.get(item.guid as string);
		if (existing) return existing;

		const task = (async (): Promise<string | null> => {
			const localItem = (await this.pmsService.resolveLocalItem([item]))[0];
			if (localItem && localItem.Media?.[0]) {
				const mappedUrl = await this.pmsService.resolveMappedUrl(item);
				if (!mappedUrl || await probeUrl(mappedUrl)) return localItem.key ?? null;

				//Drop the mapping so addStream re-ingests instead of returning the item backed by the dead URL
				await this.pmsService.removeMapping(item);
			}

			const stream = await this.stremioService.resolveStream(item);
			if (!stream || !stream.url) return null;
			return await this.pmsService.addStream(item, stream.url) ?? null;
		})().finally(() => this.tasks.delete(item.guid as string));

		this.tasks.set(item.guid as string, task);

		return task;
	}
}
