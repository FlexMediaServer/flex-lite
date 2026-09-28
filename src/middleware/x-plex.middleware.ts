import { Injectable, NestMiddleware } from '@nestjs/common';
import { NextFunction, Request, Response } from 'express';
import { toLowerCaseKeys } from '../utils/generic.js';
import { toRequestStringRecord } from '../utils/request-values.js';

@Injectable()
export class XPlexMiddleware implements NestMiddleware {
	constructor() {}

	async use(req: Request, res: Response, next: NextFunction) {
		const headers = Object.entries(req.headers);
		const queryParams = Object.entries(req.query);

		const plexValues = toRequestStringRecord([
			...headers.filter((header) => header[0].toLowerCase().startsWith('x-plex')),
			...queryParams.filter((header) => header[0].toLowerCase().startsWith('x-plex')),
		]);

		req.headers = {
			...req.headers,
			...toLowerCaseKeys(plexValues),
		};

		next();
	}
}
