import { Injectable, OnModuleInit } from '@nestjs/common';
import { Metadata } from '../dto/Metadata.entity.js';
import { CinemetaResponse, StremioContentType, StremioManifest, StremioManifestCatalog, StremioManifestCatalogWithMeta, StremioMeta, StremioStreamInfo, StremioStreamResponse, TheXemAllNames, TheXemMapping } from './stremio.js';
import { MetadataService } from '../metadata/metadata.service.js';
import { ofetch } from 'ofetch';
import { cache } from '../utils/database.js';

@Injectable()
export class StremioService implements OnModuleInit {

	private addonManifestUrl: string | null = null;
	private addonBaseUrl: string | null = null;
	private addonManifest: StremioManifest | null = null;

	private xemAllNames: Record<string, string[]> | null = null;
	private readonly XEM_REFRESH_INTERVAL_MS = 8 * 60 * 60 * 1000; // 8 hours
	private readonly XEM_CACHE_DURATION_MS = 8 * 60 * 60 * 1000; // 8 hours

	constructor (private metadataService: MetadataService) {}

	async onModuleInit() {
		const manifestUrl = process.env.STREMIO_ADDON?.trim();
		if (!manifestUrl) throw new Error('STREMIO_ADDON environment variable is not defined...');

		this.addonManifestUrl = manifestUrl;
		this.addonBaseUrl = this.getBaseUrl(manifestUrl);
		this.addonManifest = await ofetch<StremioManifest>(manifestUrl);
		console.info(`Loaded Stremio addon manifest from ${manifestUrl}`);

		this.metadataService.syncStremioCatalogs();

		// //Fetch XEM allNames on initialization
		// try {
		// 	await this.fetchAllXemSeries();
		// } catch (e) {
		// 	console.error('Failed to fetch XEM series list... ', e)
		// }

		// // Set up periodic refresh
		// setInterval(() => this.fetchAllXemSeries(), this.XEM_REFRESH_INTERVAL_MS);
	}

	private getBaseUrl(manifestUrl: string) {
		try {
			const url = new URL(manifestUrl);
			url.pathname = url.pathname.replace(/\/manifest\.json$/, '');
			url.search = '';
			url.hash = '';
			return url.toString().replace(/\/$/, '');
		} catch {
			return manifestUrl.replace(/\/manifest\.json$/, '');
		}
	}

	getManifestUrl() {
		return this.addonManifestUrl;
	}

	getAddonBaseUrl() {
		return this.addonBaseUrl;
	}

	getManifest(): StremioManifest | null {
		return this.addonManifest;
	}

	async getCatalogs(includeMeta: true): Promise<StremioManifestCatalogWithMeta[]>;
	async getCatalogs(includeMeta: false): Promise<StremioManifestCatalog[]>;
	async getCatalogs(includeMeta: boolean): Promise<StremioManifestCatalog[] | StremioManifestCatalogWithMeta[]> {
		const catalogs = this.addonManifest?.catalogs ?? [];

		if (!includeMeta) return catalogs;

		const results = await Promise.allSettled(catalogs.map((catalog) => this.getCatalog(catalog.id, catalog.type)));

		return catalogs.map((catalog, i) => {
			const result = results[i];
			return {
				...catalog,
				metas: result.status === 'fulfilled' && result.value ? result.value.metas : [],
			};
		});
	}

	async getCatalog(id: string, type?: StremioContentType): Promise<{ metas: StremioMeta[] } | null> {
		if (!this.addonBaseUrl) return null;

		const resolvedType = type ?? this.addonManifest?.catalogs.find((c) => c.id === id)?.type;
		if (!resolvedType) return null;

		const url = `${this.addonBaseUrl}/catalog/${resolvedType}/${id}.json`;
		console.debug(`Fetching catalog: ${url}`);
		return await ofetch<{ metas: StremioMeta[] }>(url);
	}

	// private async fetchAllXemSeries(): Promise<void> {
	// 	try {
	// 		const response = await ofetch<TheXemAllNames>('https://thexem.info/map/allNames?origin=tvdb');
	// 		if (response.result === 'success') {
	// 			this.xemAllNames = response.data;
	// 			console.debug(`Fetched XEM allNames successfully, ${Object.keys(response.data).length} shows mapped`);
	// 		} else {
	// 			console.error('XEM allNames fetch returned non-success result:', response.message);
	// 		}
	// 	} catch (error) {
	// 		console.error('Failed to fetch XEM allNames:', error);
	// 	}
	// }

	public async resolveStream (item: Metadata): Promise<{ url: string | undefined } | null> {
		const stremioId = await this.resolveStremioID(item);
		console.log(stremioId)
		if (!stremioId) return null;

		const streams = await this.fetchAvailableStreams(stremioId, item.type === 'show' ? 'series' : 'movie')
		if (!streams || streams.length === 0) return { url: process.env.MEDIA_NOT_FOUND_VIDEO };

		// Probe each stream URL until one is found working
		for (const stream of streams) {
			if (!stream.url) continue;

			const isWorking = await this.probeUrl(stream.url);
			if (isWorking) {
				console.debug(`Stream probe successful: ${stream.url}`);
				return { url: stream.url };
			}
			console.debug(`Stream probe failed, trying next: ${stream.url}`);
		}

		// If no working stream found, return not found URL
		return {
			url: process.env.MEDIA_NOT_FOUND_VIDEO,
		};
	}

	private async probeUrl(url: string, timeoutMs: number = 5000): Promise<boolean> {
		try {
			const response = await ofetch(url, {
				method: 'HEAD',
				timeout: timeoutMs,
				redirect: 'follow',
				ignoreResponseError: true,
			});
			
			// If HEAD request succeeds, URL is likely working
			return true;
		} catch (error) {
			// Probe failed, try next URL
			return false;
		}
	}

	private async fetchAvailableStreams(id: string, type: StremioContentType = 'movie') {
		let cachedStreams = await cache.get(`streams:${id}`);
		if (cachedStreams) return cachedStreams;
		if (!this.addonBaseUrl) {
			return null;
		}

		const url = `${this.addonBaseUrl}/stream/${type}/${id}.json`;
		console.debug(`Fetching streams: ${url}`);
		let streams = (await ofetch<StremioStreamResponse>(url))?.streams;
		await cache.set(`streams:${id}`, streams, 60 * 60 * 1000);
		return streams;
	}

	private async resolveStremioID (item: Metadata): Promise<string | null | undefined> {
		if (item.type === 'episode') {
			let stremioId;
			
			const show = await this.metadataService.getItem(item.grandparentRatingKey);
			if (!show) return null;
			const showImdbId = show.Guid?.find((guid) => guid.id.startsWith('imdb://'))?.id.replace('imdb://', '');
			const showTvdbId = show.Guid?.find((guid) => guid.id.startsWith('tvdb://'))?.id.replace('tvdb://', '');

			const cinemeta = await ofetch<CinemetaResponse>(`https://v3-cinemeta.strem.io/meta/series/${showImdbId}.json`);

			const episodeTvdbGuid = item.Guid?.find((guid) => guid.id.startsWith('tvdb://'))?.id.replace('tvdb://', '');
			const episodeTvdbId = episodeTvdbGuid ? parseInt(episodeTvdbGuid) : undefined;
			const episodeTmdbGuid = item.Guid?.find((guid) => guid.id.startsWith('tmdb://'))?.id.replace('tmdb://', '');
			const episodeTmdbId = episodeTmdbGuid ? parseInt(episodeTmdbGuid) : undefined;

			const cinemetaItem =
				cinemeta.meta.videos.find((video) => video.tvdb_id === episodeTvdbId) ||
				cinemeta.meta.videos.find((video) => video.moviedb_id === episodeTmdbId) ||
				cinemeta.meta.videos.find((video) => video.episode === item.index && video.season === item.parentIndex);

			stremioId = cinemetaItem?.id;

			//Calculate absolute episode number
			const seasons = await this.metadataService.getItemChildren(item.grandparentRatingKey);
			const episodesBefore = (seasons ?? [])
				.filter((s) => s.index !== undefined && s.index > 0 && s.index < item.parentIndex)
				.reduce((sum, s) => sum + (s.leafCount || 0), 0);
			const absoluteEpisode = episodesBefore + (item.index ?? 0);

			// console.log(showTvdbId.toString(), this.xemAllNames?.[showTvdbId.toString()], (this.xemAllNames !== undefined && this.xemAllNames[showTvdbId.toString()] !== undefined))

			// if (showTvdbId && this.xemAllNames !== null && this.xemAllNames[showTvdbId.toString()] !== undefined) {
			// 	// Try to get mapping from thexem.info using TVDB ID
			// 	try {
			// 		const cacheKey = `xem-mapping-${showTvdbId}`;
			// 		let theXemData = await cache.get<TheXemMapping>(cacheKey);

			// 		if (!theXemData) {
			// 			const theXemUrl = `https://thexem.info/map/all?id=${showTvdbId}&origin=tvdb`;
			// 			theXemData = await ofetch<TheXemMapping>(theXemUrl);
			// 			await cache.set(cacheKey, theXemData, this.XEM_CACHE_DURATION_MS);
			// 		}

			// 		if (theXemData.result === 'success' && theXemData.data?.length > 0) {
			// 			// // Get the show's TVDB season and episode from Plex
			// 			// const plexSeason = item.parentIndex;
			// 			// const plexEpisode = item.index;

			// 			// Sort by tvdb.absolute and find the matching index
			// 			const sortedMappings = theXemData.data
			// 				.filter((m) => m.tvdb?.absolute !== undefined)
			// 				.sort((a, b) => a.tvdb!.absolute - b.tvdb!.absolute);
						
			// 			const mapping = absoluteEpisode >= 0 ? sortedMappings?.[absoluteEpisode - 1] : undefined;

			// 			if (mapping?.scene && showImdbId !== undefined) {
			// 				// Cinemeta ID format: imdbid:season:episode
			// 				stremioId = `${showImdbId}:${mapping.scene.season}:${mapping.scene.episode}`;
			// 			}
			// 		}
			// 	} catch (e) {
			// 		console.error('XEM lookup failed: ', e)
			// 	}
			// }

			//If still not found, map to absolute number
			if (!stremioId) {
				const cinemetaItemByAbsolute = cinemeta.meta.videos.find((video) => video.episode === absoluteEpisode);
				stremioId = cinemetaItemByAbsolute?.id;
			}

			return stremioId;
		} else if (item.type === 'movie') {
			return item.Guid?.find((guid) => guid.id.startsWith('imdb://'))?.id.replace('imdb://', '');
		}
	}
}
