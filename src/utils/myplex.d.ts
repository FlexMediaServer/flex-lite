declare type MyPlexUser = {
	id?: number;
	uuid?: string;
	username?: string;
	title?: string;
	email?: string;
	friendlyName?: string;
	locale?: string;
	confirmed?: boolean;
	joinedAt?: number;
	emailOnlyAuth?: boolean;
	hasPassword?: boolean;
	protected?: boolean;
	thumb?: string;
	authToken?: string;
	mailingListStatus?: string;
	mailingListActive?: boolean;
	scrobbleTypes?: string;
	country?: string;
	pin?: string;
	subscription?: Subscription;
	subscriptionDescription?: string;
	restricted?: boolean;
	anonymous?: boolean;
	home?: boolean;
	guest?: boolean;
	homeSize?: number;
	homeAdmin?: boolean;
	maxHomeSize?: number;
	rememberExpiresAt?: number;
	profile?: Profile;
	entitlements?: string[];
	roles?: string[];
	services?: Service[];
	adsConsent?: null;
	adsConsentSetAt?: null;
	adsConsentReminderAt?: null;
	experimentalFeatures?: boolean;
	twoFactorEnabled?: boolean;
	backupCodesCreated?: boolean;
	attributionPartner?: null;
};

declare type Profile = {
	autoSelectAudio?: boolean;
	defaultAudioAccessibility?: number;
	defaultAudioLanguage?: string;
	defaultAudioLanguages?: null;
	defaultSubtitleLanguage?: string;
	defaultSubtitleLanguages?: null;
	autoSelectSubtitle?: AutoSubtitleSelect; // 0 = manually selected, 1 = with foreign audio, 2 = always
	defaultSubtitleAccessibility?: number;
	defaultSubtitleForced?: number;
	watchedIndicator?: number;
	mediaReviewsVisibility?: number;
};

declare enum AutoSubtitleSelect {
	MANUAL = 0,
	WITH_FOREIGN_AUDIO = 1,
	ALWAYS = 2,
}

declare type Service = {
	identifier?: string;
	endpoint?: string;
	token?: null | string;
	secret?: null | string;
	status?: Status;
};

declare enum Status {
	Online = 'online',
}

declare type Subscription = {
	active?: boolean;
	subscribedAt?: Date;
	status?: string;
	paymentService?: string;
	plan?: string;
	features?: string[];
};
