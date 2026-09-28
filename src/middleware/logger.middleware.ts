import { Request, Response, NextFunction } from 'express';
import { Injectable, NestMiddleware } from '@nestjs/common';

@Injectable()
export class LoggerMiddleware implements NestMiddleware {
	use(request: Request, response: Response, next: NextFunction): void {
		const { ip, method, originalUrl } = request;
		const userAgent = request.get('user-agent') || '';

		response.setHeader('x-plex-protocol', '1.0');

		response.on('finish', () => {
			const { statusCode } = response;
			const contentLength = response.get('content-length');

			if (
				!originalUrl.startsWith('/photo/:/transcode') &&
				!originalUrl.startsWith('/media/providers') &&
				!originalUrl.startsWith('/:/websockets/notifications')
			)
				console.debug(`${method} ${originalUrl} ${statusCode} ${contentLength} - ${userAgent} ${ip} - ${request.get('accept')}`);
		});

		next();
	}
}
