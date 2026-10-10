import { Injectable, OnModuleInit } from '@nestjs/common';
import { Metadata } from './dto/Metadata.entity.js';
import { StremioService } from './stremio/stremio.service.js';
import { PMSService } from './plex/plex.service.js';
import { probeUrl } from './utils/probe-url.js';

@Injectable()
export class AppService implements OnModuleInit {

	private readonly tasks = new Map<string, Promise<Metadata | null>>();

	constructor (
		private stremioService: StremioService,
		private pmsService: PMSService,
	) {}

	async onModuleInit () {}

	//Resolves the Plex metadata to play for an item: its own local copy, the shared not found copy, or a newly ingested stream.
	resolveMedia (item: Metadata): Promise<Metadata | null> {
		const existing = this.tasks.get(item.guid as string);
		if (existing) return existing;

		const task = (async (): Promise<Metadata | null> => {
			const localItem = (await this.pmsService.resolveLocalItem([item]))[0];
			if (localItem && localItem.Media?.[0]) {
				const mappedUrl = await this.pmsService.resolveMappedUrl(item);
				if (!mappedUrl) return localItem;

				//A real stream that still responds is reused. The not found video is never reused, so resolution runs again for it
				if (!(await this.pmsService.isNotFoundItem(item)) && await probeUrl(mappedUrl)) return localItem;

				//Drop the mapping so resolution runs again instead of returning the item backed by the dead or not found URL
				await this.pmsService.removeMapping(item);
			}

			const stream = await this.stremioService.resolveStream(item);
			if (!stream || !stream.url) return null;
			if (stream.notFound) return await this.pmsService.addNotFound(item);

			const itemId = await this.pmsService.addStream(item, stream.url);
			if (!itemId) return null;
			return (await this.pmsService.resolveLocalItem([item]))[0] ?? null;
		})().finally(() => this.tasks.delete(item.guid as string));

		this.tasks.set(item.guid as string, task);

		return task;
	}
}
