import { Injectable, NestMiddleware } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';
import { ofetch } from 'ofetch';
import { toLowerCaseKeys } from '../utils/generic.js';
import { toRequestString } from '../utils/request-values.js';
import { PMSService } from '../plex/plex.service.js';

const PROBE_CACHE_TTL = 5 * 60 * 1000; // ms

@Injectable()
export class AuthenticationMiddleware implements NestMiddleware {
	constructor(private pmsService: PMSService) {}

	private users: Record<string, any> = {};
	private probeCache: Record<string, { expiresAt: number }> = {};

	async use(req: Request, res: Response, next: NextFunction) {
		const values = toLowerCaseKeys({ ...req.headers, ...req.query });
		const plexToken = toRequestString(values['x-plex-token']);

		if (plexToken && (await this.probeAccess(plexToken))) {
			(req as any).user = await this.getUser(plexToken);
		}

		next();
	}

	async probeAccess (token: string) {
		const cached = this.probeCache[token];

		if (cached) {
			if (Date.now() < cached.expiresAt) return true;
			delete this.probeCache[token];
		}

		try {
			await this.pmsService.plexServerApi('/', { query: { 'X-Plex-Token': token } });
			this.probeCache[token] = { expiresAt: Date.now() + PROBE_CACHE_TTL };
			return true;
		} catch {
			return false;
		}
	}

	async getUser (token: string) {
		let user = this.users[token]

		if (!user) {
			user = await ofetch('https://plex.tv/api/v2/user', {
				headers: {
					Accept: 'application/json',
					'X-Plex-Token': token
				}
			});
			this.users[token] = user;
		}

		return user
	}
}
