import { Injectable, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { Metadata } from './dto/Metadata.entity.js';
import { StremioService } from './stremio/stremio.service.js';
import { PMSService } from './plex/plex.service.js';
import { probeUrl } from './utils/probe-url.js';
import { withinDurationMargin } from './utils/duration.js';
import { db } from './utils/database.js';

@Injectable()
export class AppService implements OnModuleInit, OnApplicationShutdown {

	private readonly tasks = new Map<string, Promise<Metadata | null>>();

	constructor (
		private stremioService: StremioService,
		private pmsService: PMSService,
	) {}

	async onModuleInit () {}

	//Called after the HTTP server has closed, so no request is still using the database
	async onApplicationShutdown () {
		await db.destroy();
	}

	//Resolves the Plex metadata to play for an item: its own local copy, the shared not found copy, or a newly ingested stream.
	resolveMedia (item: Metadata): Promise<Metadata | null> {
		const existing = this.tasks.get(item.guid as string);
		if (existing) return existing;

		const task = (async (): Promise<Metadata | null> => {
			const localItem = (await this.pmsService.resolveLocalItem([item]))[0];
			if (localItem && localItem.Media?.[0]) {
				const mappedUrl = await this.pmsService.resolveMappedUrl(item);
				if (!mappedUrl) return localItem;

				//A real stream that still responds and matches the item's length is reused. The not found video is never reused, so resolution runs again for it
				if (!(await this.pmsService.isNotFoundItem(item)) && await probeUrl(mappedUrl) && withinDurationMargin(item.duration, localItem.Media[0].duration)) return localItem;

				//Drop the mapping so resolution runs again instead of returning the item backed by the dead, mismatched or not found URL
				await this.pmsService.removeMapping(item);
			}

			const candidates = await this.stremioService.streamCandidates(item);
			if (!candidates) return null;

			for await (const url of candidates) {
				const itemId = await this.pmsService.addStream(item, url);
				if (!itemId) continue;

				const resolved = (await this.pmsService.resolveLocalItem([item]))[0] ?? null;
				if (resolved && withinDurationMargin(item.duration, resolved.Media?.[0]?.duration)) return resolved;

				//The stream's length is not the item's, so its Plex copy and mapping are removed rather than cached. The next stream is tried.
				await this.pmsService.removeMapping(item);
			}

			return await this.pmsService.addNotFound(item);
		})().finally(() => this.tasks.delete(item.guid as string));

		this.tasks.set(item.guid as string, task);

		return task;
	}
}
