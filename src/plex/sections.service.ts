import { Injectable } from '@nestjs/common';
import type { Metadata } from '../dto/Metadata.entity.js';
import { PMSService } from './plex.service.js';
import { isLocalId } from '../utils/item-id.js';

export type VirtualSection = { key: number; title: string; type: 'movie' | 'show' };

const REFRESH_MS = 60 * 1000;

//Items of these types are filed under the section for their kind (seasons and episodes belong to the show section)
const SECTION_KIND: Record<string, 'movie' | 'show'> = { movie: 'movie', show: 'show', season: 'show', episode: 'show' };

//Sections whose location is under /virtual are served by Flex. Every other section stays real Plex.
@Injectable()
export class SectionsService {
	private sections: VirtualSection[] = [];
	private refreshedAt = 0;
	private refreshing?: Promise<void>;

	constructor(private readonly pmsService: PMSService) {}

	get enabled(): boolean {
		return this.sections.length > 0;
	}

	get(key: string | number | undefined): VirtualSection | undefined {
		return this.sections.find((section) => section.key === Number(key));
	}

	isVirtual(key: string | number | undefined): boolean {
		return !!this.get(key);
	}

	sectionFor(item: Pick<Metadata, 'type'>): VirtualSection | undefined {
		const kind = SECTION_KIND[item.type];
		return kind ? this.sections.find((section) => section.type === kind) : undefined;
	}

	//Stamps the item with the section it belongs to, by its type. Plex's own items keep the section Plex gave them:
	//local ratingKeys are Plex's, and a real librarySectionID is Plex's filing (Flex's Discover ids are never numeric)
	stamp<T extends Metadata>(item: T): T {
		if (isLocalId(item.ratingKey?.split('/').pop() ?? '')) return item;
		if (item.librarySectionID !== undefined && !this.isVirtual(item.librarySectionID)) return item;

		const section = this.sectionFor(item);
		if (section) {
			Object.assign(item, {
				librarySectionID: section.key,
				librarySectionKey: `/library/sections/${section.key}`,
				librarySectionTitle: section.title,
			});
		}

		return item;
	}

	//Container section fields when every item shares one section, otherwise none (mixed hubs)
	containerOf(items: Pick<Metadata, 'type'>[]): { librarySectionID?: number; librarySectionTitle?: string } {
		const sections = new Set(items.map((item) => this.sectionFor(item)));
		const [section] = sections;
		return sections.size === 1 && section ? { librarySectionID: section.key, librarySectionTitle: section.title } : {};
	}

	//Reloads the sections at most once a minute, on the first request after the window expires
	async refreshIfStale(): Promise<void> {
		if (Date.now() - this.refreshedAt < REFRESH_MS) return;

		this.refreshing ??= this.refresh().finally(() => (this.refreshing = undefined));
		return this.refreshing;
	}

	private async refresh(): Promise<void> {
		try {
			const response = await this.pmsService.plexServerApi('/library/sections');

			this.sections = (response?.MediaContainer?.Directory ?? []).flatMap((directory: any) => {
				const virtual = directory.Location?.some((location: any) => location.path?.startsWith('/virtual'));
				return virtual && (directory.type === 'movie' || directory.type === 'show')
					? [{ key: Number(directory.key), title: directory.title, type: directory.type }]
					: [];
			});
		} catch (error: any) {
			//Keep the last known sections so a Plex outage does not switch takeover off
			console.error(`Could not load Plex library sections: ${error?.message ?? error}`);
		} finally {
			this.refreshedAt = Date.now();
		}
	}
}
