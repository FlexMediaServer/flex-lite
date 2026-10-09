import { Request, Response, NextFunction } from 'express';
import { Injectable, NestMiddleware } from '@nestjs/common';
import { ClientType } from './client-identifier.middleware.js';

@Injectable()
export class LoggerMiddleware implements NestMiddleware {
	use(request: Request, response: Response, next: NextFunction): void {
		const { ip, method, originalUrl } = request;
		const userAgent = request.get('user-agent') || '';

		response.setHeader('x-plex-protocol', '1.0');

		response.on('finish', () => {
			const { statusCode } = response;
			const contentLength = response.get('content-length');

			let clientType = Object.entries(ClientType)?.[(request as any)?.clientType]?.[1];

			if (
				!originalUrl.startsWith('/photo/:/transcode') &&
				!originalUrl.startsWith('/media/providers') &&
				!originalUrl.startsWith('/:/websockets/notifications')
			)
				console.debug(`${statusCode} ${method} ${originalUrl} \n ${contentLength} ${request.get('accept')} \n User Agent: ${userAgent} \n Client Type: ${clientType} \n IP: ${ip}`);
		});

		next();
	}
}
