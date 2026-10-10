import { Injectable, OnModuleInit } from '@nestjs/common';
import { Metadata } from '../dto/Metadata.entity.js';
import { CinemetaResponse, StremioContentType, StremioManifest, StremioManifestCatalog, StremioManifestCatalogWithMeta, StremioMeta, StremioStreamInfo, StremioStreamResponse } from './stremio.js';
import { MetadataService } from '../metadata/metadata.service.js';
import { ofetch } from 'ofetch';
import { cache } from '../utils/database.js';
import { probeUrl } from '../utils/probe-url.js';
import { getMediaNotFoundUrl } from '../utils/media-not-found.js';

//Stream resolution holds playback open, so the retry is kept to one extra attempt after a short wait
const RESOLVE_ATTEMPTS = 2;
const RESOLVE_RETRY_DELAY_MS = 1000;

@Injectable()
export class StremioService implements OnModuleInit {

	private addonManifestUrl: string | null = null;
	private addonBaseUrl: string | null = null;
	private addonManifest: StremioManifest | null = null;

	constructor (private metadataService: MetadataService) {}

	async onModuleInit() {
		const manifestUrl = process.env.STREMIO_ADDON?.trim();
		if (!manifestUrl) throw new Error('STREMIO_ADDON environment variable is not defined...');

		this.addonManifestUrl = manifestUrl;
		this.addonBaseUrl = this.getBaseUrl(manifestUrl);
		this.addonManifest = await ofetch<StremioManifest>(manifestUrl);
		console.info(`Loaded Stremio addon manifest from ${manifestUrl}`);

		this.metadataService.syncStremioCatalogs();
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

	public async resolveStream (item: Metadata): Promise<{ url: string | undefined; notFound?: boolean } | null> {
		const stremioId = await this.resolveStremioID(item);
		if (!stremioId) return null;

		const type = item.type === 'episode' ? 'series' : 'movie';

		//Stream lists can be empty or stale on the first try, so the retry fetches them fresh before falling back to not found
		for (let attempt = 1; attempt <= RESOLVE_ATTEMPTS; attempt++) {
			if (attempt > 1) {
				console.debug(`No working stream for ${stremioId}, retrying in ${RESOLVE_RETRY_DELAY_MS}ms`);
				await new Promise((resolve) => setTimeout(resolve, RESOLVE_RETRY_DELAY_MS));
			}

			const streams = await this.fetchAvailableStreams(stremioId, type, attempt > 1);

			// Probe each stream URL until one is found working
			for (const stream of streams ?? []) {
				if (!stream.url) continue;

				const isWorking = await probeUrl(stream.url);
				if (isWorking) {
					console.debug(`Stream probe successful: ${stream.url}`);
					return { url: stream.url };
				}
				console.debug(`Stream probe failed, trying next: ${stream.url}`);
			}
		}

		// If no working stream found after every attempt, return not found URL
		return {
			url: getMediaNotFoundUrl(),
			notFound: true,
		};
	}

	private async fetchAvailableStreams(id: string, type: StremioContentType = 'movie', refresh = false) {
		// return [];
		let cachedStreams = refresh ? undefined : await cache.get(`streams:${id}`);
		if (cachedStreams) return cachedStreams;
		if (!this.addonBaseUrl) {
			return null;
		}

		const url = `${this.addonBaseUrl}/stream/${type}/${id}.json`;
		console.debug(`Fetching streams: ${url}`);
		let streams = (await ofetch<StremioStreamResponse>(url))?.streams;
		//Empty results are not cached, so a retry can still find streams the addon has added since
		if (streams?.length) await cache.set(`streams:${id}`, streams, 60 * 60 * 1000);
		return streams;
	}

	private async resolveStremioID (item: Metadata): Promise<string | null | undefined> {
		if (item.type === 'episode') {
			let stremioId;
			
			const show = await this.metadataService.getItem(item.grandparentRatingKey);
			if (!show) return null;
			const showImdbId = show.Guid?.find((guid) => guid.id.startsWith('imdb://'))?.id.replace('imdb://', '');

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
