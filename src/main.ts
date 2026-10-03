import { NestFactory } from '@nestjs/core';
import { WsAdapter } from '@nestjs/platform-ws';
import { AppModule, ObserveInstrument } from './app.module.js';
import { createProxyMiddleware, fixRequestBody, responseInterceptor } from 'http-proxy-middleware';
import { FormatInterceptor } from './format.interceptor.js';
import dotenv from 'dotenv';
dotenv.config();

export const PROXY = {
	enabled: false
};

async function bootstrap() {
	const app = await NestFactory.create(AppModule, {
		instrument: ObserveInstrument,
	});


	// Define your target backend or microservice URL
	const TARGET_URL = process.env.PLEX_BASE ?? 'http://localhost:32400';

	const pathFilter = function (path: string, req: any) {
		// return !(path.startsWith('/transcode') && req.method === 'GET');
		if (path.startsWith('/library/all')) return !PROXY.enabled;
		if (path.startsWith('/hubs/')) return !PROXY.enabled;
		if (path.startsWith('/dummy.mkv')) return !PROXY.enabled;
		if (path.startsWith('/library/parts')) return !PROXY.enabled;
		if (path.startsWith('/:/timeline')) return !PROXY.enabled;
		if (path.startsWith('/:/scrobble')) return !PROXY.enabled;
		if (path.startsWith('/video/:/transcode/universal/decision')) return !PROXY.enabled;
		if (path.startsWith('/video/:/transcode/universal/start')) return !PROXY.enabled;
		if (path.startsWith('/media/providers')) return !PROXY.enabled;
		if (path.startsWith('/library/metadata')) return !PROXY.enabled;
		if (path.startsWith('/library/search')) return !PROXY.enabled;
		if (path.startsWith('/playQueues')) return !PROXY.enabled;
		if (path.startsWith('/webdav')) return !PROXY.enabled;
		return true;
	};

	app.useGlobalInterceptors(new FormatInterceptor());
	app.enableCors();

	// Attach websocket gateways (e.g. the Plex notifications proxy) to this same HTTP server
	app.useWebSocketAdapter(new WsAdapter(app));

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

	await app.listen(process.env.FLEX_PORT ?? 32404);
	console.log(`Started on port ${process.env.FLEX_PORT}`)
}
await bootstrap();
