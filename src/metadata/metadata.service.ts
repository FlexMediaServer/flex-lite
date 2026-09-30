import { Injectable } from '@nestjs/common';
import { normalizeQueryParams } from '../utils/request-values.js';
import { ofetch, type $Fetch } from 'ofetch';
import { cache } from '../utils/database.js';
import { Metadata } from '../dto/Metadata.entity.js';
import { Hub } from '../dto/Hub.entity.js';

@Injectable()
export class MetadataService {

	authToken = process.env.PLEX_TOKEN

	public hubs: Hub[] = [];

	public discoverApi: $Fetch = ofetch.create({
		baseURL: 'https://discover.provider.plex.tv',
		headers: { Accept: 'application/json' },
		retry: 10,
		retryDelay: 1000, // ms
		retryStatusCodes: [500, 429, 408], // response status codes to retry
		timeout: 30000, // Timeout after 3 seconds
		onRequest: ({ options }) => {
			options.query = {
				...normalizeQueryParams(options.query),
				'X-Plex-Product': 'Plex Web',
				'X-Plex-Version': '4.159.0',
				'X-Plex-Client-Identifier': 'ubmn93amq1bg3zb2as6le4oe',
				'X-Plex-Platform': 'Chrome',
				'X-Plex-Platform-Version': '146.0',
				'X-Plex-Features': 'external-media,indirect-media,hub-style-list',
				'X-Plex-Model': 'standalone',
				'X-Plex-Device': 'Windows',
				'X-Plex-Device-Screen-Resolution': '1055x1066,2195x1235',
				'X-Plex-Token': this.authToken,
				'X-Plex-Provider-Version': '7.2',
				'X-Plex-Text-Format': 'plain',
				'X-Plex-Drm': 'widevine',
				'X-Plex-Language': 'en',
			};
		},
	});

	async getItem(id: string, noCache = false): Promise<Metadata | null> {
		let item = noCache ? null : await cache.get(`metadata:${id}`);

		if (!item) {
			try {
				item = (
					await this.discoverApi<{ MediaContainer?: { Metadata?: Metadata[] } }>(
						`/library/metadata/${encodeURIComponent(id)}`,
						{
							query: {
								includeConcerts: 1,
								includeExtras: 1,
								includeOnDeck: 1,
								includePopularLeaves: 1,
								includePreferences: 1,
								includeReviews: 1,
								includeChapters: 1,
								includeStations: 1,
								includeExternalMedia: 1,
								asyncAugmentMetadata: 1,
								asyncCheckFiles: 1,
								asyncRefreshAnalysis: 1,
								asyncRefreshLocalMediaAgent: 1,
							},
						},
					)
				)?.MediaContainer?.Metadata?.[0];
			} catch {
				return null;
			}

			if (item?.Media) {
				delete item.Media;
			}

			if (!noCache && item) {
				await cache.set(`metadata:${id}`, item, 3600 * 1000);
			}
		}
		
			
		if (!item) return null;

		return item;
	}

	async getItemChildren(id: string): Promise<Metadata[] | null> {
		const result = await this.discoverApi<{ MediaContainer?: { Metadata?: Metadata[] } }>(
			`/library/metadata/${id}/children`,
			{
				query: {
					excludeAllLeaves: 1,
					'X-Plex-Container-Size': 100,
				},
			},
		);

		if (!result) return null;

		if (result?.MediaContainer?.Metadata) {
			for (const item of result?.MediaContainer?.Metadata) {
				if (item.Media) {
					delete item.Media;
				}
			}
		}

		return result?.MediaContainer?.Metadata as Metadata[];
	}
}
