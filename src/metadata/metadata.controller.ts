import { Controller, Get, NotFoundException, Param, Query, Req, UseGuards, Headers, BadRequestException, Put, Delete } from '@nestjs/common';
import type { Request } from 'express';
import { MediaContainer } from '../dto/MediaContainer.entity.js';
import { IsXML } from '../is-xml.decorator.js';
import { MetadataService } from './metadata.service.js';
import { Metadata } from '../dto/Metadata.entity.js';
import { plainToInstance } from 'class-transformer';
import { PMSService } from '../plex/plex.service.js';
import { Client } from '../utils/client.decorator.js';
import { User } from '../utils/user.decorator.js';
import { ClientType } from '../middleware/client-identifier.middleware.js';
import { StremioService } from '../stremio/stremio.service.js';
import { cache, db } from '../utils/database.js';
import { playbackUserOf } from '../status/playback-sessions.js';
import { rewriteSession } from '../status/sessions.js';
import { Hub } from '../dto/Hub.entity.js';
import { AppService } from '../app.service.js';
import { LoggedInGuard } from '../middleware/logged-in.guard.js';
import { discoverPageSize } from './discover-page-size.js';
import { SectionsService } from '../plex/sections.service.js';
import { isLocalId } from '../utils/item-id.js';
import { toRequestString } from '../utils/request-values.js';
import { mergeContinueWatching, mergeHubs, mergeSearch, uniqueByGuid, withoutItems } from './hub-merge.js';

export type DiscoverSearchResult = {
	id: string;
	SearchResult?: Array<{
		Metadata?: Metadata;
	}>;
};

const tokenOf = (headers: any) => toRequestString(headers['x-plex-token']) ?? '';

@Controller()
@UseGuards(LoggedInGuard)
export class MetadataController {
	constructor(
		private appService: AppService,
		private readonly metadataService: MetadataService,
		private readonly stremioService: StremioService,
		private readonly pmsService: PMSService,
		private readonly sections: SectionsService,
	) {}

	public async onModuleInit(): Promise<void> {

	}

	//Items the requesting user has on the real Plex server, minus those inside virtual sections (Flex serves those by Discover id)
	private async plexMetadata(path: string, headers: any): Promise<Metadata[]> {
		try {
			const response = await this.pmsService.plexUserApi(tokenOf(headers))(path);
			return (response?.MediaContainer?.Metadata ?? []).filter((item: Metadata) => !this.sections.isVirtual(item.librarySectionID));
		} catch (error: any) {
			console.error(`Plex ${path} failed: ${error?.message ?? error}`);
			return [];
		}
	}

	private async plexHubs(path: string, headers: any, query?: Record<string, any>): Promise<Hub[]> {
		try {
			const response = await this.pmsService.plexUserApi(tokenOf(headers))(path, { query });
			return withoutItems(response?.MediaContainer?.Hub ?? [], (item) => this.sections.isVirtual(item.librarySectionID));
		} catch (error: any) {
			console.error(`Plex ${path} failed: ${error?.message ?? error}`);
			return [];
		}
	}

	//Discover search results for a query, as Metadata
	private async discoverSearch(query: string): Promise<Metadata[]> {
		const response = await this.metadataService.discoverApi<{ MediaContainer: { SearchResults: DiscoverSearchResult[] } }>('/library/search', {
			query: {
				query,
				limit: 30,
				searchTypes: 'availabilityPlatforms,categories,movies,people,tvod,tv',
				searchProviders: 'discover,plexAVOD,plexTVOD',
				includeMetadata: 1,
				filterPeople: 1,
			},
		});

		const externalSearch = response.MediaContainer.SearchResults.find((result) => result.id === 'external');
		return (externalSearch?.SearchResult ?? []).flatMap((result) => {
			if (!result.Metadata) return [];

			(result.Metadata as any).source = undefined;
			return [this.sections.stamp(result.Metadata)];
		});
	}

	//Trims each hub to its first ten items and strips the fields home screens do not use
	private trimHubs(hubs: Hub[], isXML: boolean): Hub[] {
		return hubs.map((hub) => {
			const result = new Hub({ ...hub });

			if (result.Metadata !== undefined) {
				const metadata = result.Metadata?.slice(0, 10).map((item) => {
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
					return this.sections.stamp(item);
				}) ?? [];

				if (result.Metadata.length > 10) {
					result.more = true;
				}

				if (isXML) {
					delete result.Metadata;
					result.Video = metadata;
				} else {
					result.Metadata = metadata;
				}
			}

			return result;
		});
	}

	@Get('/library/search')
	async search(@Query() query: { query: string }, @Headers() headers: any) {
		const [local, discover] = await Promise.all([
			this.plexHubs('/hubs/search', headers, { query: query.query, limit: 30 }).then((hubs) => hubs.flatMap((hub) => hub.Metadata ?? [])),
			this.discoverSearch(query.query),
		]);

		//Each library keeps its own copy of a show, so the local and virtual results are listed separately
		const searchResults = [...local, ...discover].map((metadata) => ({ Metadata: metadata }));

		return {
			MediaContainer: {
				size: searchResults.length,
				SearchResult: searchResults,
			},
		};
	}

	//Now Playing: Plex reports Flex-served items as their Plex copy under the owner. Swap in Flex's item and the real viewer.
	@Get('/status/sessions')
	async sessions(@Headers() headers: any) {
		const response = await this.pmsService.plexUserApi(tokenOf(headers))('/status/sessions');
		const container = response?.MediaContainer ?? {};

		const sessions = await Promise.all(
			(container.Metadata ?? []).map(async (session: any) => {
				const mapping = await db.selectFrom('item_mappings').select('guid').where('item_id', '=', String(session.ratingKey)).executeTakeFirst();
				const flexItem = mapping ? await this.metadataService.getItem(mapping.guid) : null;
				const viewer = playbackUserOf(session.Player?.playbackSessionId);

				return rewriteSession(session, flexItem ? this.sections.stamp(flexItem) : undefined, viewer);
			}),
		);

		return { MediaContainer: { ...container, size: sessions.length, Metadata: sessions } };
	}

	@Get('/hubs/search')
	async hubsSearch(@Query() query: { query: string }, @Headers() headers: any, @IsXML() isXML: boolean) {
		const [upstream, discover] = await Promise.all([
			this.plexHubs('/hubs/search', headers, { query: query.query, limit: 30 }),
			this.discoverSearch(query.query),
		]);

		return {
			MediaContainer: new MediaContainer({
				identifier: 'com.plexapp.plugins.library',
				allowSync: true,
				Hub: this.trimHubs(mergeSearch(upstream, discover), isXML),
			}),
		};
	}

	//Continue Watching from the user's Plex server and Flex's own progress, most recently viewed first
	private async continueWatchingItems(user: MyPlexUser, headers: any): Promise<Metadata[]> {
		const [plex, flex] = await Promise.all([
			this.plexMetadata('/hubs/continueWatching/items', headers),
			this.metadataService.getContinueWatching(user),
		]);

		return mergeContinueWatching(plex, flex);
	}

	@Get('/hubs/continueWatching')
	async continueWatching(@User() user: MyPlexUser, @IsXML() isXML: boolean, @Headers() headers: any) {
		const items = await this.continueWatchingItems(user, headers);

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
	async continueWatchingItemsRoute(@User() user: MyPlexUser, @Headers() headers: any) {
		const items = await this.continueWatchingItems(user, headers);

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
		const metadata = this.sections.stamp(new Metadata(item));

		return {
			MediaContainer: new MediaContainer({
				identifier: 'com.plexapp.plugins.library',
				...this.sections.containerOf([metadata]),
				allowSync: false,
				Metadata: [metadata],
			})
		}
	}

	//Items of a virtual section: Flex's own items whose type belongs to that section
	@Get(['/library/sections/:key/all', '/library/sections/:key/recentlyAdded'])
	sectionItems(@Param() params: { key: string }, @Headers() headers: any, @IsXML() isXML: boolean) {
		const section = this.sections.get(params.key);
		if (!section) throw new NotFoundException();

		const items = uniqueByGuid(this.metadataService.hubs.flatMap((hub) => hub.Metadata ?? []))
			.map((item) => this.sections.stamp(item))
			.filter((item) => item.librarySectionID === section.key);
		const offset = parseInt(headers['x-plex-container-start']) || 0;
		const limit = parseInt(headers['x-plex-container-size']) || 50;
		const page = items.slice(offset, offset + limit);

		return {
			MediaContainer: new MediaContainer({
				identifier: 'com.plexapp.plugins.library',
				...this.sections.containerOf(page),
				allowSync: false,
				totalSize: items.length,
				offset,
				[isXML ? 'Video' : 'Metadata']: page,
			}),
		};
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

	//Batch lookup of mixed ids (eg. a hub's items). Local ids come from the Plex server, Discover ids from Flex.
	private async metadataList(ids: string[], headers: any, user: MyPlexUser, isXML: boolean) {
		const localIds = ids.filter(isLocalId);
		const local = new Map<string, Metadata>();

		if (localIds.length) {
			const response = await this.pmsService.plexUserApi(tokenOf(headers))(`/library/metadata/${localIds.join(',')}`);
			for (const item of response?.MediaContainer?.Metadata ?? []) local.set(String(item.ratingKey), item);
		}

		const found = await Promise.all(ids.map(async (id) => (isLocalId(id) ? local.get(id) : this.metadataService.getItem(id))));
		const flexItems = found.filter((item, index) => item && !isLocalId(ids[index])) as Metadata[];
		await this.metadataService.hydrateMetadata(flexItems, user);

		const items = found.filter((item): item is Metadata => !!item);

		return {
			MediaContainer: new MediaContainer({
				identifier: 'com.plexapp.plugins.library',
				...this.sections.containerOf(items),
				allowSync: true,
				[isXML ? 'Video' : 'Metadata']: items.map((item) => new Metadata(item)),
			}),
		};
	}

	@Get('/library/metadata/:id')
	async metadata(@User() user: MyPlexUser, @Headers() headers: any, @Query() query: any, @Param() params: any, @IsXML() isXML: boolean, @Client() clientType: ClientType) {
		if (params.id.includes(',')) return this.metadataList(params.id.split(','), headers, user, isXML);

		let metadata = await this.metadataService.getItem(params.id, true);
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

		await this.metadataService.hydrateMetadata([metadata], user);

		this.metadataService.applyDummyMedia(metadata, clientType)

		return {
			MediaContainer: new MediaContainer({
				identifier: 'com.plexapp.plugins.library',
				...this.sections.containerOf([metadata]),
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
				'X-Plex-Container-Start': query['X-Plex-Container-Start'] ?? headers['x-plex-container-start'],
				'X-Plex-Container-Size': discoverPageSize(type, query['X-Plex-Container-Size'] ?? headers['x-plex-container-size']),
			},
		});

		const metadata = children.MediaContainer?.Metadata?.filter(
			(item: Metadata) => !item.originallyAvailableAt || new Date(item.originallyAvailableAt.replaceAll('-', '/')) <= new Date(),
		).map((metadata) => {
			if (metadata.Media) {
				delete metadata.Media;
			}

			return this.sections.stamp(metadata);
		});

		const result = plainToInstance(MediaContainer, {
			...children.MediaContainer,
			Metadata: metadata,
			identifier: 'com.plexapp.plugins.library',
			...this.sections.containerOf(metadata ?? []),
			allowSync: true,
			totalSize: children.MediaContainer?.totalSize !== undefined
				? children.MediaContainer.totalSize - ((children.MediaContainer.Metadata?.length ?? 0) - (metadata?.length ?? 0))
				: undefined,
		});

		const metadataItems = result.Metadata || [];
		await this.metadataService.hydrateMetadata(metadataItems, user);

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

		//Related hubs mix sections, so the container carries no section
		const hubs: Hub[] = (related?.MediaContainer?.Hub ?? []).map((hub: Hub) => {
			hub.Metadata?.forEach((item) => this.sections.stamp(item));
			return hub;
		});

		return {
			MediaContainer: new MediaContainer({
				identifier: 'com.plexapp.plugins.library',
				allowSync: true,
				Hub: hubs,
			})
		}
	}

	//Hub items are shared by every user, so each request hydrates its own copies with that user's state
	private async hydratedHubs(hubs: Hub[], user: MyPlexUser): Promise<Hub[]> {
		const copies = hubs.map((hub) => new Hub({ ...hub, Metadata: hub.Metadata?.map((item) => ({ ...item }) as Metadata) }));

		//Only the first items of each hub are shown on the home screen
		await this.metadataService.hydrateMetadata(copies.flatMap((hub) => hub.Metadata?.slice(0, 10) ?? []), user);
		return copies;
	}

	private async hydratedItems(items: Metadata[], user: MyPlexUser): Promise<Metadata[]> {
		const copies = items.map((item) => ({ ...item }) as Metadata);
		await this.metadataService.hydrateMetadata(copies, user);
		return copies;
	}

	//Home hubs: Flex's Stremio catalogs merged with the user's Plex hubs. A virtual section shows only Flex's hubs of its type.
	@Get(['/hubs/promoted', '/hubs', '/hubs/sections/:library'])
	async promoted(
		@Param() params: { library?: string },
		@Query() query: {
			contentDirectoryID: string;
			pinnedContentDirectoryID: string; //Split by comma
		},
		@IsXML() isXML: boolean,
		@Headers() headers: any,
		@User() user: MyPlexUser,
	) {
		if (query.pinnedContentDirectoryID && query.contentDirectoryID) {
			const pinnedLibraries = query.pinnedContentDirectoryID.split(',');
			if (query.contentDirectoryID !== pinnedLibraries[0] && query.contentDirectoryID !== query.pinnedContentDirectoryID) return;
		}

		const section = this.sections.get(params.library);
		const flex = await this.hydratedHubs(section ? this.metadataService.hubs.filter((hub) => hub.type === section.type) : this.metadataService.hubs, user);
		const upstream = section ? [] : await this.plexHubs('/hubs/promoted', headers);

		return {
			MediaContainer: new MediaContainer({
				identifier: 'com.plexapp.plugins.library',
				allowSync: true,
				Hub: this.trimHubs(mergeHubs(upstream, flex), isXML),
			})
		}
	}

	@Get('/hubs/:id/items')
	async getHubItems (@Param() params: any, @Query() query: any, @Headers() headers: any, @IsXML() isXML: boolean, @User() user: MyPlexUser) {
		const metadata = this.metadataService.hubs.find((hub) => hub.hubIdentifier === params.id)?.Metadata
		const offset = parseInt(headers['x-plex-container-start']) || 0;
		const limit = parseInt(headers['x-plex-container-size']) || 50;
		return {
			MediaContainer: new MediaContainer({
				identifier: 'com.plexapp.plugins.library',
				[isXML ? 'Video' : 'Metadata']: (await this.hydratedItems(metadata?.slice(offset, offset+limit) ?? [], user)).map(item => {
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
					return this.sections.stamp(item)
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

			await cache.set(req.path, result, 3600 * 1000);

			return result;
		} catch {
			throw new NotFoundException();
		}
	}

	@Delete(['/library/metadata/:id/media/:mediaId', '/library/metadata/:id'])
	async deleteMedia(@Param() params: { id: string; mediaId?: string }, @Headers() headers: any) {
		const itemId = params.id;

		// Proxy local item deletion to Plex
		if (isLocalId(itemId)) {
			const path = params.mediaId
				? `/library/metadata/${itemId}/media/${params.mediaId}`
				: `/library/metadata/${itemId}`;
			return await this.pmsService.plexUserApi(tokenOf(headers))(path, {
				method: 'DELETE'
			});
		}

		// Handle virtual item deletion
		const item = await this.metadataService.getItem(itemId);
		if (!item) throw new NotFoundException();

		try {
			await this.metadataService.deleteMedia(item);
		} catch (error: any) {
			throw new NotFoundException(error?.message ?? 'Failed to delete media');
		}

		return {
			MediaContainer: new MediaContainer({})
		};
	}
}
