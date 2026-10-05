import { Injectable, NestMiddleware } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';
import { ofetch } from 'ofetch';
import { toLowerCaseKeys } from '../utils/generic.js';
import { toRequestString } from '../utils/request-values.js';
import { PMSService } from '../plex/plex.service.js';

interface PlexAccessToken {
	id: number;
	uuid?: string;
	token: string;
	type: 'device' | 'invited-user' | 'owned-user';
	publicAddress?: string;
	invited?: Record<string, any>;
	[key: string]: unknown;
}

type PlexUser = Record<string, any>;

const ACCESS_TOKENS_TTL = 30 * 1000; // ms
const BLOCKED_TOKEN_TTL = 30 * 60 * 1000; // ms

@Injectable()
export class AuthenticationMiddleware implements NestMiddleware {
	constructor(private pmsService: PMSService) {}

	private ownerUser: PlexUser;
	private accessTokens: PlexAccessToken[] = [];
	private accessTokensExpiresAt = 0;
	private blockedTokens: Record<string, number> = {};

	async use(req: Request, res: Response, next: NextFunction) {
		const values = toLowerCaseKeys({ ...req.headers, ...req.query });
		const plexToken = toRequestString(values['x-plex-token']);

		if (plexToken) {
			(req as any).user = await this.getSession(plexToken);
		}

		next();
	}

	async getSession(token: string) {
		if (await this.isBlocked(token)) return;

		let access = this.accessTokens.find((access) => access.token === token);
		if (!access) await this.getAccessTokens();
		access = this.accessTokens.find((access) => access.token === token);

		if (!access) {
			this.blockedTokens[token] = Date.now() + BLOCKED_TOKEN_TTL;
			return;
		}

		if (access.type === 'device') {
			return this.ownerUser ?? (await this.fetchOwnerUser());
		}

		return access.invited;
	}

	private async isBlocked(token: string) {
		const blockedUntil = this.blockedTokens[token];
		if (!blockedUntil) return false;

		if (Date.now() < blockedUntil) return true;

		delete this.blockedTokens[token];
		return false;
	}

	async getAccessTokens(): Promise<PlexAccessToken[]> {
		if (Date.now() < this.accessTokensExpiresAt) return this.accessTokens;

		this.accessTokens = await ofetch<PlexAccessToken[]>('https://plex.tv/api/v2/server/access_tokens', {
			query: { auth_token: this.pmsService.plexToken },
			headers: { Accept: 'application/json' },
		});
		this.accessTokensExpiresAt = Date.now() + ACCESS_TOKENS_TTL;

		return this.accessTokens;
	}

	async fetchOwnerUser(): Promise<PlexUser> {
		const user = await ofetch<PlexUser>('https://plex.tv/api/v2/user', {
			headers: {
				Accept: 'application/json',
				'X-Plex-Token': this.pmsService.plexToken,
			},
		});

		this.ownerUser = user;
		return user;
	}
}
