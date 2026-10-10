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

			//Set by AuthenticationMiddleware, which runs after this middleware, so it is read when the response finishes
			const user = (request as any).user as MyPlexUser | undefined;
			const userName = user?.username ?? user?.title ?? '-';
			const platform = request.get('x-plex-platform') ?? Object.entries(request.query).find(([key]) => key.toLowerCase() === 'x-plex-platform')?.[1];
			const product = request.get('x-plex-product') ?? Object.entries(request.query).find(([key]) => key.toLowerCase() === 'x-plex-product')?.[1];

			if (
				!originalUrl.startsWith('/photo/:/transcode') &&
				!originalUrl.startsWith('/media/providers') &&
				!originalUrl.startsWith('/:/websockets/notifications')
			)
				console.debug(`${statusCode} ${method} ${originalUrl} \n ${contentLength} ${request.get('accept')} \n User: ${userName} \n User Agent: ${userAgent} \n Client Type: ${clientType} \n IP: ${ip} \n Platform: ${platform} | Product: ${product}`);
		});

		next();
	}
}
