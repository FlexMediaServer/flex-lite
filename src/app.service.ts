import { Injectable, OnModuleInit } from '@nestjs/common';
import { Metadata } from './dto/Metadata.entity.js';
import { StremioService } from './stremio/stremio.service.js';
import { PMSService } from './plex/plex.service.js';

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
			const localItem = await this.pmsService.resolveLocalItem(item);
			if (localItem && localItem.Media?.[0]) return localItem.key ?? null;

			const stream = await this.stremioService.resolveStream(item);
			if (!stream || !stream.url) return null;
			return await this.pmsService.addStream(item, stream.url) ?? null;
		})().finally(() => this.tasks.delete(item.guid as string));

		this.tasks.set(item.guid as string, task);

		return task;
	}
}
