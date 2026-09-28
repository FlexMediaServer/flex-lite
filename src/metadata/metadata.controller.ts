import { Controller, Get, NotFoundException, Param, Query, Req, UseGuards, Headers } from '@nestjs/common';
import type { Request } from 'express';
import { MediaContainer } from '../dto/MediaContainer.entity.js';
import { IsXML } from '../is-xml.decorator.js';
import { MetadataService } from './metadata.service.js';
import { Metadata } from '../dto/Metadata.entity.js';
import { plainToInstance } from 'class-transformer';
import { PMSService } from '../plex/plex.service.js';
import { createPlatformMediaPlaceholder, emptyMedia } from '../utils/plex.js';
import { Client } from '../middleware/client.decorator.js';
import { ClientType } from '../middleware/client-identifier.middleware.js';
import { StremioService } from '../stremio/stremio.service.js';
import { cache } from '../utils/database.js';

const isNumeric = (val: any) => val !== '' && val !== null && Number.isFinite(Number(val));

export type DiscoverSearchResult = {
	id: string;
	SearchResult?: Array<{
		Metadata?: Metadata;
	}>;
};

@Controller()
export class MetadataController {
	constructor(
		private readonly metadataService: MetadataService,
		private readonly stremioService: StremioService,
		private readonly pmsService: PMSService,
	) {}

	public async onModuleInit(): Promise<void> {
		
	}

	@Get('/library/search')
	async search(@Query() query: { query: string }) {
		const response = await this.metadataService.discoverApi<{ MediaContainer: { SearchResults: DiscoverSearchResult[] } }>('/library/search', {
			query: {
				query: query.query,
				limit: 30,
				searchTypes: 'availabilityPlatforms,categories,movies,people,tvod,tv',
				searchProviders: 'discover,plexAVOD,plexTVOD',
				includeMetadata: 1,
				filterPeople: 1,
			},
		});

		const externalSearch = response.MediaContainer.SearchResults.find((result) => result.id === 'external');
		const searchResults = externalSearch?.SearchResult?.filter((searchResult) => searchResult.Metadata !== undefined) ?? [];

		return {
			MediaContainer: {
				size: searchResults ? searchResults.length : 0,
				SearchResult: await Promise.all(
					searchResults?.map((result) => {
						if (result.Metadata) {
							result.Metadata.librarySectionTitle = 'Flex';
							(result.Metadata as any).source = undefined;
						}
						return result;
					}),
				),
			},
		};
	}

	@Get('/hubs/metadata/:id/related')
	hubsMetadataRelated() {
		return {
			MediaContainer: new MediaContainer({})
		};
	}

	@Get('/library/metadata/:id')
	async metadata(@Headers() headers: any, @Query() query: any, @Param() params: any, @IsXML() isXML: boolean, @Client() clientType: ClientType) {
		let metadata = await this.metadataService.getItem(params.id);
		if (!metadata) throw new NotFoundException();
		
		//Forces stream resolution. This fixes an issue that prevents playback from starting when going to next item in play queue. Currently only targets web, however some other clients may need this enabled as well.
		if (clientType === ClientType.WEB && query['X-Plex-Playback-Id'] && (metadata.type === 'episode' || metadata.type === 'movie')) {
			const stream = await this.stremioService.resolveStream(metadata);
			if (!stream || !stream?.url) throw new NotFoundException()
			await this.pmsService.addStream(metadata, stream?.url)
		}

		const localItem = await this.pmsService.resolveLocalItem(metadata);
		let useEmptyMedia = false;

		switch (clientType) {
			case ClientType.NATIVE_ANDROID:
			case ClientType.NATIVE_APPLE:
				useEmptyMedia = true;
				break;
		}

		if (metadata?.type === 'episode' || metadata?.type === 'movie') metadata.Media = localItem?.Media && localItem?.Media?.[0] ? [localItem.Media[0]] : (useEmptyMedia) ? emptyMedia() as any : [];

		return {
			MediaContainer: new MediaContainer({
				identifier: 'com.plexapp.plugins.library',
				librarySectionID: 2,
				allowSync: true,
				[isXML ? 'Video' : 'Metadata']: [new Metadata(metadata)],
			})
		}
	}

	//Gets child elements of library item. eg. seasons/episodes. Proxy to plex discover
	@Get(['/library/metadata/:id/children', '/library/metadata/:id/grandchildren'])
	async metadataChildren(
		@Req() req: any,
		@Param() params: any,
		@Query() query: any,
		@Headers() headers: any
	) {
		const type: 'grandchildren' | 'children' = req.path.endsWith('/grandchildren') ? 'grandchildren' : 'children';
		const children = await this.metadataService.discoverApi<{ MediaContainer?: MediaContainer }>(`/library/metadata/${params.id}/${type}`, {
			query: {
				excludeAllLeaves: 1,
				'X-Plex-Container-Start': query['x-plex-container-start'] || headers['x-plex-container-start'],
				'X-Plex-Container-Size': query['x-plex-container-size'] || headers['x-plex-container-size'] || 100,
			},
		});

		const metadata = children.MediaContainer?.Metadata?.filter(
			(item: Metadata) => !item.originallyAvailableAt || new Date(item.originallyAvailableAt.replaceAll('-', '/')) <= new Date(),
		).map((metadata) => {
			if (metadata.Media) {
				delete metadata.Media;
			}

			return metadata;
		});

		const result = plainToInstance(MediaContainer, {
			...children.MediaContainer,
			Metadata: metadata,
			identifier: 'com.plexapp.plugins.library',
			librarySectionID: 2,
			allowSync: true,
			totalSize: children.MediaContainer?.totalSize !== undefined
				? children.MediaContainer.totalSize - ((children.MediaContainer.Metadata?.length ?? 0) - (metadata?.length ?? 0))
				: undefined,
		});

		for (const metadata of result.Metadata || []) {
			if (metadata.type === 'movie' || metadata.type === 'episode') {
				let localItem = await this.pmsService.resolveLocalItem(metadata);
				if (localItem && localItem.Media?.[0]) {
					metadata.Media = [localItem.Media[0]];
				} else {
					metadata.Media = createPlatformMediaPlaceholder(metadata.ratingKey, headers['user-agent']);
				}
			}

			// if (progress) {
			// 	metadata.duration = toOptionalNumber(progress.duration);
			// 	metadata.viewOffset = !progress.complete ? toOptionalNumber(progress.progress) : undefined;
			// 	metadata.viewCount = progress.complete ? 1 : undefined;
			// }

			metadata.userState = true;
		}

		return {
			MediaContainer: result
		};
	}

	@Get('/library/metadata/:id/related')
	async related(@Param() params: any, @Query() query: any, @Headers() headers: any) {
		const related = await this.metadataService.discoverApi(`/library/metadata/${params.id}/related`, {
			query: {
				excludeAllLeaves: 1,
				'X-Plex-Container-Start': query['x-plex-container-start'] || headers['x-plex-container-start'],
				'X-Plex-Container-Size': query['x-plex-container-size'] || headers['x-plex-container-size'] || 100,
			},
		});

		return {
			MediaContainer: new MediaContainer({
				identifier: 'com.plexapp.plugins.library',
				librarySectionID: 2,
				allowSync: true,
				Hub: related?.MediaContainer?.Hub,
			})
		}
	}

	// @Get('/hubs/metadata/:library/:id/related')
	// relatedHubs() {
	// 	return {
	// 		MediaContainer: new MediaContainer({
	// 			identifier: 'com.plexapp.plugins.library',
	// 			librarySectionID: 2,
	// 			allowSync: true,
	// 			totalSize: 0,
	// 			offset: 0,
	// 		})
	// 	}
	// }

	@Get(['/library/metadata/*path'])
	async nestedMeta(@Req() req: Request) {
		const cached = await cache.get(req.path, { raw: true });
		if (cached) return cached.value;

		try {
			const result = await this.metadataService.discoverApi(req.path, {
				query: {
					count: 12,
					includeLibraryPlaylists: 1,
					includeStations: 1,
					includeRecentChannels: 1,
					includeMeta: 1,
					includeExternalMetadata: 1,
					excludeFields: 'summary',
				},
			});

			await cache.set(req.path, result);

			return result;
		} catch {
			throw new NotFoundException();
		}
	}
}
