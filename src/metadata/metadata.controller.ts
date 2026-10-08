import { Controller, Get, NotFoundException, Param, Query, Req, UseGuards, Headers, BadRequestException, Put } from '@nestjs/common';
import type { Request } from 'express';
import { MediaContainer } from '../dto/MediaContainer.entity.js';
import { IsXML } from '../is-xml.decorator.js';
import { MetadataService } from './metadata.service.js';
import { Metadata } from '../dto/Metadata.entity.js';
import { plainToInstance } from 'class-transformer';
import { PMSService } from '../plex/plex.service.js';
import { createPlatformMediaPlaceholder, emptyMedia } from '../utils/plex.js';
import { Client } from '../utils/client.decorator.js';
import { User } from '../utils/user.decorator.js';
import { ClientType } from '../middleware/client-identifier.middleware.js';
import { StremioService } from '../stremio/stremio.service.js';
import { cache } from '../utils/database.js';
import { Hub } from '../dto/Hub.entity.js';
import { AppService } from '../app.service.js';
import { LoggedInGuard } from '../middleware/logged-in.guard.js';

export type DiscoverSearchResult = {
	id: string;
	SearchResult?: Array<{
		Metadata?: Metadata;
	}>;
};

@Controller()
@UseGuards(LoggedInGuard)
export class MetadataController {
	constructor(
		private appService: AppService,
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


	@Get('/hubs/continueWatching')
	async continueWatching(@User() user: MyPlexUser, @Headers('x-plex-token') plexToken: string, @IsXML() isXML: boolean) {
		const items = await this.metadataService.getContinueWatching(user, plexToken);

		return {
			MediaContainer: new MediaContainer({
				identifier: 'com.plexapp.plugins.library',
				allowSync: true,
				Hub: [
					new Hub({
						key: '/hubs/continueWatching/items',
						hubKey: `/library/metadata/${items.map((item) => item.ratingKey).join(',')}`,
						title: 'Continue Watching',
						type: 'mixed',
						hubIdentifier: 'continueWatching',
						context: 'hub.continueWatching',
						more: false,
						style: 'hero',
						[isXML ? 'Video' : 'Metadata']: items,
					}),
				],
			})
		}
	}

	@Get('/hubs/continueWatching/items')
	async continueWatchingItems(@User() user: MyPlexUser, @Headers('x-plex-token') plexToken: string, @IsXML() isXML: boolean) {
		const items = await this.metadataService.getContinueWatching(user, plexToken);

		return {
			MediaContainer: new MediaContainer({
				identifier: 'com.plexapp.plugins.library',
				allowSync: true,
				Metadata: items,
			})
		}
	}

	@Get('/hubs/metadata/:id/related')
	hubsMetadataRelated() {
		return {
			MediaContainer: new MediaContainer({})
		};
	}

	@Put('/actions/removeFromContinueWatching')
	async removeFromContinueWatching(@Query() query: { key?: string; ratingKey?: string }, @User() user: MyPlexUser) {
		await this.metadataService.removeFromContinueWatching(query.ratingKey ?? query.key ?? '', user);

		return {
			MediaContainer: new MediaContainer({})
		};
	}

	@Get('/library/all')
	async libraryAll(@Query() query: any) {
		let item;
		if (query['show.guid']) {
			const showGuid = query['show.guid'].split('/').pop();
			if (!showGuid) throw new BadRequestException('show.guid is invalid');

			const seasons = await this.metadataService.getItemChildren(showGuid);
			if (!seasons) throw new NotFoundException();
			const seasonIndex = Number.parseInt(query['season.index'] || '', 10);

			item = seasons.find((season: any) => season.index === seasonIndex);
		} else {
			const guid = query.guid?.split('/').pop();
			if (!guid) throw new BadRequestException('guid is required');

			item = await this.metadataService.getItem(guid);
		}

		if (!item) throw new NotFoundException();
		const metadata = new Metadata(item);

		metadata.librarySectionTitle = 'Flex';
		metadata.librarySectionID = 2;
		metadata.librarySectionKey = '/library/sections/2';

		return {
			MediaContainer: new MediaContainer({
				identifier: 'com.plexapp.plugins.library',
				librarySectionID: 2,
				allowSync: false,
				Metadata: [metadata].filter((item) => item),
			})
		}
	}

	@Get('/library/metadata/:id/subtitles')
	async subtitles (@Param() params: any, @Headers() headers: any, @Query() query: any) {
		let metadata = await this.metadataService.getItem(params.id);
		if (!metadata) throw new NotFoundException();

		const localItem = (await this.pmsService.resolveLocalItem([metadata]))[0];
		if (!localItem) throw new NotFoundException();

		query['X-Plex-Playback-Session-Id'] = undefined;
		query['X-Plex-Playback-Id'] = undefined;

		return await this.pmsService.plexServerApi(`/library/metadata/${localItem.ratingKey}/subtitles`, {
			method: 'GET',
			query,
			headers
		})
	}

	@Get('/library/metadata/:id')
	async metadata(@User() user: MyPlexUser, @Headers() headers: any, @Query() query: any, @Param() params: any, @IsXML() isXML: boolean, @Client() clientType: ClientType) {
		let metadata = await this.metadataService.getItem(params.id);
		if (!metadata) throw new NotFoundException();
		
		//Forces stream resolution. This fixes an issue that prevents playback from starting when going to next item in play queue. Currently only targets web and roku, however some other clients may need this enabled as well.
		if (
			(
				(clientType === ClientType.ROKU && headers['x-plex-playback-session-id']) || 
				(clientType === ClientType.WEB && headers['x-plex-playback-id']) || 
				(clientType === ClientType.BIGSCREEN && headers['x-plex-playback-id']) ||
				(clientType === ClientType.NATIVE_ANDROID && query.checkFiles == '1' && query.asyncAugmentMetadata !== '1')
			) && (metadata.type === 'episode' || metadata.type === 'movie')
		) {
			const itemPath = await this.appService.resolveMedia(metadata);
			if (!itemPath) throw new NotFoundException()
		}

		await this.metadataService.hydrateMetadata([metadata], user, headers['x-plex-token']);

		this.metadataService.applyDummyMedia(metadata, clientType)

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
		@User() user: MyPlexUser,
		@Param() params: any,
		@Query() query: any,
		@Headers() headers: any,
		@Client() clientType: ClientType
	) {
		const type: 'grandchildren' | 'children' = req.path.endsWith('/grandchildren') ? 'grandchildren' : 'children';
		const children = await this.metadataService.discoverApi<{ MediaContainer?: MediaContainer }>(`/library/metadata/${params.id}/${type}`, {
			query: {
				excludeAllLeaves: 1,
				'X-Plex-Container-Start': headers['x-plex-container-start'],
				'X-Plex-Container-Size': headers['x-plex-container-size'] || 100,
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

		const metadataItems = result.Metadata || [];
		await this.metadataService.hydrateMetadata(metadataItems, user, headers['x-plex-token']);

		for (const metadata of metadataItems) {
			this.metadataService.applyDummyMedia(metadata, clientType)
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

	//Define hubs for user's homepage
	@Get(['/hubs/promoted', '/hubs', '/hubs/sections/:library'])
	promoted(
		@Query() query: {
			contentDirectoryID: string;
			pinnedContentDirectoryID: string; //Split by comma
		},
		@IsXML() isXML: boolean,
	) {
		if (query.pinnedContentDirectoryID && query.contentDirectoryID) {
			const pinnedLibraries = query.pinnedContentDirectoryID.split(',');
			if (query.contentDirectoryID !== pinnedLibraries[0] && query.contentDirectoryID !== query.pinnedContentDirectoryID) return;
		}

		return {
			MediaContainer: new MediaContainer({
				identifier: 'com.plexapp.plugins.library',
				allowSync: true,
				Hub: this.metadataService.hubs.map((hub) => {
					const result = new Hub({ ...hub });

					if (result.Metadata !== undefined) {
						const metadata = result.Metadata?.slice(0, 10).map(item => {
							delete item.Rating;
							delete (item as Metadata & { Actor: any }).Actor;
							delete (item as Metadata & { Collection: any }).Collection;
							delete (item as Metadata & { Country: any }).Country;
							delete (item as Metadata & { Label: any }).Label;
							delete (item as Metadata & { Mood: any }).Mood;
							delete (item as Metadata & { Part: any }).Part;
							delete (item as Metadata & { Producer: any }).Producer;
							delete (item as Metadata & { Similar: any }).Similar;
							delete (item as Metadata & { Photo: any }).Photo;
							return item
						}) ?? [];

						if (result.Metadata.length > 10) {
							result.more = true;
						}

						if (isXML) {
							delete result.Metadata;
							result.Video = metadata
						} else {
							result.Metadata = metadata
						}
					}

					return result;
				})
			})
		}
	}

	@Get('/hubs/:id/items')
	async getHubItems (@Param() params: any, @Query() query: any, @Headers() headers: any, @IsXML() isXML: boolean) {
		const metadata = this.metadataService.hubs.find((hub) => hub.hubIdentifier === params.id)?.Metadata
		const offset = parseInt(headers['x-plex-container-start']) || 0;
		const limit = parseInt(headers['x-plex-container-size']) || 50;
		return {
			MediaContainer: new MediaContainer({
				identifier: 'com.plexapp.plugins.library',
				[isXML ? 'Video' : 'Metadata']: metadata?.slice(offset, offset+limit).map(item => {
					delete item.Rating;
					delete (item as Metadata & { Actor: any }).Actor;
					delete (item as Metadata & { Collection: any }).Collection;
					delete (item as Metadata & { Country: any }).Country;
					delete (item as Metadata & { Label: any }).Label;
					delete (item as Metadata & { Mood: any }).Mood;
					delete (item as Metadata & { Part: any }).Part;
					delete (item as Metadata & { Producer: any }).Producer;
					delete (item as Metadata & { Similar: any }).Similar;
					delete (item as Metadata & { Photo: any }).Photo;
					return item
				}) ?? [],
				totalSize: metadata?.length,
				offset: offset
			})
		}
	}

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
