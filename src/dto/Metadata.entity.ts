import { Media } from './Media.entity.js';
import { Image } from './Image.entity.js';
import { Rating } from '../dto/Rating.entity.js';
import { UltraBlurColors } from './UltraBlurColors.entity.js';
import { Exclude, Expose, Transform, Type } from 'class-transformer';

@Expose()
export class Metadata {
	@Exclude()
	keyPrefix = '/library/metadata';

	type: 'show' | 'movie' | 'episode' | 'season' | 'clip';

	index?: number;
	playQueueItemID?: string;

	key: string;

	ratingKey: string;

	// ratingKey: string; //The play queues requests in some Plex apps append the ratingKey to the metadata base URL. As such rating key must match the metadata URL format exactly... So if the metadata URL is /metadata/<library/<id>, then ratingKey must be <library>/<id>
	guid?: string; //eg. plex://episode/68ec89c449b9526d4b7250a3
	title?: string;
	titleSort?: string;
	thumb: string;
	art?: string;
	banner?: string;

	contentRating?: string; // e.g. 'TV-14'
	addedAt?: number; //Unix timestamp
	originallyAvailableAt?: string; // ISO 8601 date string

	userState?: boolean;
	skipDetails?: boolean;
	skipParent?: boolean;

	@Transform(({ value }) => (value ? Number.parseInt(value) : undefined))
	year: number;

	parentKey: string;
	parentIndex: number;
	parentRatingKey: string;
	parentTitle: string;
	parentThumb: string;
	parentGuid: string;
	parentYear: number;

	grandparentKey: string;
	grandparentRatingKey: string;
	grandparentTitle: string;
	grandparentThumb: string;
	grandparentGuid: string;
	grandparentSlug: string;
	grandparentArt?: string;
	// "grandparentArt": "/library/metadata/435070/art/1719895857",
	// "grandparentTheme": "/library/metadata/435070/theme/1719895857",
	skipChildren: boolean; //If Metadata object is a show, this will cause the client to skip the /children call for the show and call /grandchildren to get the episode list.

	librarySectionID: number; //eg 1
	librarySectionKey: string; //eg. /library/sections/1
	librarySectionTitle: string; //eg. TV Shows

	summary: string;

	@Type(() => Number)
	@Transform(({ value }) => (value ? Number.parseInt(value) : 0))
	audienceRating: number;

	duration?: number;
	viewOffset?: number;

	viewedLeafCount: number;
	leafCount: number;
	viewCount: number;
	lastViewedAt?: number; // Unix timestamp

	Guid?: { id: string }[];

	@Type(() => Media)
	Media?: Media[];

	@Type(() => Image)
	Image?: Image[];

	@Type(() => Rating)
	Rating?: Rating[];

	@Type(() => UltraBlurColors)
	UltraBlurColors?: UltraBlurColors;

	//Plex Discover Properties
	@Exclude()
	availabilityId: string;
	@Exclude()
	streamingMediaId: string;
	@Exclude()
	publicPagesURL: string;
	@Exclude()
	playableKey: string;
	@Exclude()
	source: string;

	constructor(values: Partial<Metadata>) {
		Object.assign(this, values);

		//Allow user state (scrobble/timeline) on metadata item
		this.userState = true;
	}
}
