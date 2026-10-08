import { Exclude, Expose, Type } from 'class-transformer';
import { Hub } from './Hub.entity.js';
import { Metadata } from './Metadata.entity.js';
import { MediaProvider } from './provider/MediaProvider.entity.js';

@Expose()
export class MediaContainer {
	@Expose()
	get size(): number {
		return this.Hub?.length || this.Metadata?.length || this.MediaProvider?.length || this.UserState?.length || 0;
	}

	totalSize: number;
	offset: number;
	librarySectionID: number;
	librarySectionTitle: string;
	librarySectionUUID: string;
	allowSync: boolean;
	nocache: boolean;
	identifier?: 'com.plexapp.plugins.library';

	@Exclude()
	excludeElements?: string; //Comma-separated list of elements to exclude from response

	// START PlayQueues properties
	mediaTagPrefix?: string;
	mediaTagVersion?: number;
	playQueueID?: string;
	playQueueSelectedItemID?: string;
	playQueueSelectedItemOffset?: number;
	playQueueSelectedMetadataItemID?: string;
	playQueueShuffled?: boolean;
	playQueueSourceURI?: string;
	playQueueTotalCount?: number;
	playQueueVersion?: number;
	// END PlayQueues properties

	// START MediaProvider properties
	allowCameraUpload: true;
	allowChannelAccess: true;
	allowMediaDeletion: true;
	allowSharing: true;
	allowTuners: true;
	apiVersion: '0.1.0';
	backgroundProcessing: true;
	certificate: true;
	companionProxy: true;
	countryCode: 'usa';
	diagnostics: 'logs,databases,streaminglogs';
	eventStream: true;
	friendlyName: string; //Plex server name
	livetv: 7;
	machineIdentifier: string; //Machine identifier which is used for Plex
	musicAnalysis: 2;
	myPlex: boolean; //Whether server is linked to myPlex - eg. true
	myPlexMappingState: 'mapped';
	myPlexSigninState: 'ok';
	myPlexSubscription: true; //Whether they have Plex Pass or not
	myPlexUsername: string; //Email of the owner's Plex account.
	offlineTranscode: number; //eg. 1 -  Not sure what this does, or if it's a boolean flag or not as it's represented as an integer.
	ownerFeatures: string; //Feature flags separated by commas. Most are UUID's so it's not well understood what each one does.
	platform: string; //Operating System  eg. "Linux"
	platformVersion: string; //OS version / Linux Kernel version. eg. "6.8.12-2-pve"
	pluginHost: boolean; //true
	pushNotifications: boolean; //true
	readOnlyLibraries: boolean; // false
	streamingBrainABRVersion: number; //eg. 3
	streamingBrainVersion: number; //eg. 2
	sync: boolean; //Not sure what this does... This is set to true on the real Plex server.
	transcoderActiveVideoSessions: number; //Number of current transcode sessions
	transcoderAudio: boolean; //true
	transcoderLyrics: boolean; //true
	transcoderSubtitles: boolean; //true
	transcoderVideo: boolean; //true
	transcoderVideoBitrates: string; //"64,96,208,320,720,1500,2000,3000,4000,8000,10000,12000,20000"
	transcoderVideoQualities: string; //"0,1,2,3,4,5,6,7,8,9,10,11,12"
	transcoderVideoResolutions: string; //"128,128,160,240,320,480,768,720,720,1080,1080,1080,1080"
	updatedAt: number; //Unix timestamp
	updater: boolean; //true
	version: string; //"1.41.2.9200-c6bbc1b53"
	voiceSearch: boolean; //true
	//END MediaProvider properties

	//START Decision Endpoint
	mdeDecisionCode: 1000 | 3000;
	mdeDecisionText: 'Direct play OK.' | 'App cannot direct play this item. Direct play is disabled.';
	directPlayDecisionCode: 3000 | 1000;
	directPlayDecisionText: 'App cannot direct play this item. Direct play is disabled.' | 'Direct play OK.';
	generalDecisionCode: 1001 | 2000 | 1000;
	generalDecisionText: 'Direct play not available; Conversion OK.' | 'Neither direct play nor conversion is available.' | 'Direct play OK.';
	resourceSession: string;
	transcodeDecisionCode: 1001 | 4005 | 1000;
	transcodeDecisionText:
		| 'Direct play not available; Conversion OK.'
		| 'Cannot convert this item. No conversion audio and video encoders could be found in app profile.'
		| 'Direct play OK.';
	//END Decision Endpoint

	@Type(() => Metadata) Metadata?: Metadata[];
	@Type(() => Hub) Hub?: Hub[];
	@Type(() => MediaProvider) MediaProvider?: MediaProvider[];
	UserState?: Record<string, unknown>[];

	constructor(values: Partial<MediaContainer>) {
		Object.assign(this, values);
	}
}
