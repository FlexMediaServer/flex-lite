import { Injectable, NestMiddleware } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';

//Client type defines the client behavior we are targeting. Eg. is this client sharing the same codebase and behavior.
export enum ClientType {
	//Newer React Native powered clients. Both TV and mobile share the same codebase and versioning.
	REACT_NATIVE,

	//Native Apple: iOS and Apple TV app share the same codebase and versioning
	NATIVE_APPLE,
	//Native Android: Android and Android TV client share the same codebase and versioning
	NATIVE_ANDROID,

	ROKU, //Roku devices
	WEB, //Includes web and desktop clients (non-HTPC)
	BIGSCREEN //Most vendor TV clients will fall under this. Includes HTPC client. (This is harder to identify as there is no standard identifier for this specific codebase)
}

/*
Example client user agents:

Apple:
iOS (Native): Unknown
Apple TV (Native): PlexTV/8.45 (Apple TV; tvOS 26.4; Scale/2.00)
NOTE: 8.45 is the last native iOS version
Plex Mobile (React Native) [iOS]: Plex/1743 CFNetwork/3860.600.12 Darwin/25.5.0

Android:
Android (Native): Mozilla/5.0 (Linux; Android 9; SM-G998B Build/SP1A.210812.016; wv)PlexMobile/10.26.0.2578
NOTE: 10.30.6 is the last version of the native Plex for Android.
Android TV (Native): Mozilla/5.0 (Linux; Android 14; onn. Full HD Streaming Device Build/URO1.250103.055.A2; wv)PlexTV/10.30.8.4222
Plex Mobile (React Native) [Android]: Mozilla/5.0 (Linux; Android 9; SM-G998B Build/SP1A.210812.016; wv)PlexMobile/2026.10.0 (971050186)

Roku (Native): Roku/DVP-15.2 (15.2.4.3455-E6)

Plex HTPC (Native) [Bigscreen Client]: Plex HTPC; 1.71.1.346-f62ce923; Windows 10 Version 2009

Plex Tizen [Bigscreen Client]: 
Mozilla/5.0 (SMART-TV; LINUX; Tizen 5.5) AppleWebKit/537.36 (KHTML, like Gecko) 69.0.3497.106/5.5 TV Safari/537.36 ::ffff:172.20.0.3
SamsungDASH/2.0 (;;;;;) ::ffff:172.20.0.3


Web: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36
*/

@Injectable()
export class ClientIdentifier implements NestMiddleware {
	constructor() {}

	async use(req: Request & { clientType: ClientType }, res: Response, next: NextFunction) {

		const userAgent = req.get('user-agent') || '';

		// Detect client type based on user agent patterns
		// Roku detection (simple pattern)
		if (userAgent?.includes('Roku/')) {
			req.clientType = ClientType.ROKU
		}
		// React Native iOS (Plex/ with CFNetwork/Darwin)
		else if (userAgent?.includes('Plex/') && userAgent?.includes('CFNetwork')) {
			req.clientType = ClientType.REACT_NATIVE
		}
		// React Native Android (PlexMobile/ with year-based version 2026+)
		else if (userAgent?.includes('PlexMobile/') && userAgent?.match(/PlexMobile\/20\d{2}/)) {
			req.clientType = ClientType.REACT_NATIVE
		}
		// Native Apple TV (PlexTV/ with tvOS)
		else if (userAgent?.includes('PlexTV/') && userAgent?.includes('tvOS')) {
			req.clientType = ClientType.NATIVE_APPLE
		}
		// Native Android TV (PlexTV/ with Android, not React Native)
		else if (userAgent?.includes('PlexTV/') && userAgent?.includes('Android') && !userAgent?.match(/PlexMobile\/20\d{2}/)) {
			req.clientType = ClientType.NATIVE_ANDROID
		}
		// Native Android mobile (PlexMobile/ with version < 2026, contains Mozilla/5.0 and wv)
		else if (userAgent?.includes('PlexMobile/') && userAgent?.includes('Mozilla/5.0') && userAgent?.includes('wv')) {
			const versionMatch = userAgent.match(/PlexMobile\/(\d+)/);
			if (versionMatch && parseInt(versionMatch[1]) < 2026) {
				req.clientType = ClientType.NATIVE_ANDROID
			} else {
				req.clientType = ClientType.REACT_NATIVE
			}
		}
		// Plex HTPC / Bigscreen client
		else if (userAgent?.includes('Plex HTPC')) {
			req.clientType = ClientType.BIGSCREEN
		}
		// Web clients (Chrome, Safari, etc. with AppleWebKit)
		else if (userAgent?.includes('AppleWebKit')) {
			req.clientType = ClientType.WEB
		}
		// Default fallback
		else {
			req.clientType = ClientType.WEB
		}

		next();
	}
}
