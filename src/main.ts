import { NestFactory } from '@nestjs/core';
import { AppModule, ObserveInstrument } from './app.module.js';
import { createProxyMiddleware, fixRequestBody, responseInterceptor } from 'http-proxy-middleware';
import { FormatInterceptor } from './format.interceptor.js';
import dotenv from 'dotenv';
dotenv.config();

async function bootstrap() {
	const app = await NestFactory.create(AppModule, {
		instrument: ObserveInstrument,
	});


	// Define your target backend or microservice URL
	const TARGET_URL = process.env.PLEX_BASE ?? 'http://localhost:32400';

	const pathFilter = function (path: string, req: any) {
		// return !(path.startsWith('/transcode') && req.method === 'GET');
		if (path.startsWith('/library/all')) return false;
		if (path.startsWith('/dummy.mkv')) return false;
		if (path.startsWith('/library/parts')) return false;
		if (path.startsWith('/:/timeline')) return false;
		if (path.startsWith('/:/scrobble')) return false;
		if (path.startsWith('/video/:/transcode/universal/decision')) return false;
		if (path.startsWith('/video/:/transcode/universal/start')) return false;
		if (path.startsWith('/media/providers')) return false;
		if (path.startsWith('/library/metadata')) return false;
		if (path.startsWith('/library/search')) return false;
		if (path.startsWith('/playQueues')) return false;
		if (path.startsWith('/webdav')) return false;
		return true;
	};

	app.useGlobalInterceptors(new FormatInterceptor());
	app.enableCors();

	app.use((req: any, res: any, next: any) => {
		// req.baseUrl = req.baseUrl.replace(/\/{2,}/g, '/');
		req.originalUrl = req.originalUrl.replace(/\/{2,}/g, '/');
		req.url = req.url.replace(/\/{2,}/g, '/');
		next();
	});

	// Global proxy for ALL requests
	app.use(
		createProxyMiddleware({
			target: TARGET_URL,
			changeOrigin: true, // Rewrites the host header to match the target
			secure: true,       // Set to false if target uses self-signed SSL certs
			pathFilter: pathFilter,
			selfHandleResponse: true, // res.end() will be called internally by responseInterceptor()
			on: {
				// Essential hook to fix hanging POST/PUT requests caused by body-parsers
				proxyReq: fixRequestBody,
				proxyRes: responseInterceptor(async (responseBuffer, proxyRes: any, req, res) => {
					const exchange = `[DEBUG] ${req.method} ${req.path} -> ${proxyRes.req.protocol}//${proxyRes.req.host}${proxyRes.req.path} [${proxyRes.statusCode}]`;
					console.log(exchange); // [DEBUG] GET / -> http://www.example.com [200]
					return responseBuffer; // manipulate response and return the result
				}),
			},
		}),
	);

	await app.listen(process.env.PORT ?? 32404);
}
await bootstrap();
