type CinemetaEpisode = {
	id: string;
	tvdb_id?: number;
	moviedb_id?: number;
	episode?: number;
	season?: number;
};

type CinemetaResponse = {
	meta: {
		videos: CinemetaEpisode[];
	};
};

type TheXemMapping = {
	result: string;
	data: Array<{
		scene?: {
			season: number;
			episode: number;
			absolute: number;
		};
		anidb?: {
			season: number;
			episode: number;
			absolute: number;
		};
		tvdb?: {
			season: number;
			episode: number;
			absolute: number;
		};
	}>;
};

type TheXemAllNames = {
	result: string;
	data: Record<string, string[]>;
	message: string;
};

export type StremioContentType = 'movie' | 'series' | 'other' | 'tv' | 'events' | 'anime';

export interface StremioManifestCatalog {
	type: StremioContentType;
	id: string;
	name: string;
}

export interface StremioManifestResource {
	name: string;
	types: StremioContentType[];
	idPrefixes?: string[];
}

export interface StremioManifest {
	name: string;
	id: string;
	version: string;
	description: string;
	catalogs: StremioManifestCatalog[];
	resources: StremioManifestResource[];
	types: StremioContentType[];
	logo?: string;
	behaviorHints?: Record<string, boolean>;
	addonCatalogs?: StremioManifestCatalog[];
}

export interface StremioTrailer {
	source: string;
	type: string;
}

export interface StremioTrailerStream {
	title: string;
	ytId: string;
}

export interface StremioLink {
	name: string;
	category: string;
	url: string;
}

export interface StremioStreamInfo {
	name?: string;
	title?: string;
	description?: string;
	behaviorHints?: {
		bingeGroup?: string;
		notWebReady?: boolean;
		videoHash?: string;
		videoSize?: string;
		filename?: string;
	};
	url?: string;
	externalUrl?: string;
	ytId?: string;
	thumbnail?: string;
	icons?: {
		source?: string;
	};
}

export interface StremioStreamResponse {
	streams?: StremioStreamInfo[];
}

export interface StremioMeta {
	id: string;
	type: StremioContentType;
	name: string;
	poster?: string;
	genres?: string[];
	imdbRating?: string;
	releaseInfo?: string;
	director?: string[];
	cast?: string[];
	description?: string;
	trailers?: StremioTrailer[];
	links?: StremioLink[];
	imdb_id?: string;
	popularities?: Record<string, number>;
	country?: string;
	genre?: string[];
	released?: string;
	slug?: string;
	writer?: string[];
	year?: string;
	moviedb_id?: number;
	runtime?: string;
	background?: string;
	logo?: string;
	awards?: string;
	popularity?: number;
	trailerStreams?: StremioTrailerStream[];
	behaviorHints?: Record<string, boolean | string>;
}

export interface StremioManifestCatalogWithMeta extends StremioManifestCatalog {
	metas: StremioMeta[];
}