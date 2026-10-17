import dotenv from 'dotenv';
import { NestFactory } from '@nestjs/core';
import { WsAdapter } from '@nestjs/platform-ws';
import { AppModule, ObserveInstrument } from './app.module.js';
import { createProxyMiddleware, fixRequestBody } from 'http-proxy-middleware';
import { FormatInterceptor } from './format.interceptor.js';
import { SectionsService } from './plex/sections.service.js';
import { PlayQueuesService } from './play-queues/play-queues.service.js';
import { shouldProxy } from './utils/proxy-filter.js';
dotenv.config();

export const PROXY = {
	enabled: false
};

const debugFn = console.debug;
console.debug = (...properties) => {
	if (process.env.LOG_LEVEL === 'debug') debugFn('[DEBUG]', ...properties);
};

const infoFn = console.info;
console.info = (...properties) => {
	if (process.env.LOG_LEVEL === 'info' || process.env.LOG_LEVEL === 'debug') infoFn('[INFO]', ...properties);
};


async function bootstrap() {
	const app = await NestFactory.create(AppModule, {
		instrument: ObserveInstrument,
		//Playback streams and notification sockets stay open for hours, so shutdown closes them rather than waiting
		forceCloseConnections: true,
	});

	//Runs the shutdown hooks on SIGTERM/SIGINT, which close the database once the server has stopped
	app.enableShutdownHooks();


	// Define your target backend or microservice URL
	const TARGET_URL = process.env.PLEX_BASE ?? 'http://localhost:32400';

	const sections = app.get(SectionsService);
	const playQueues = app.get(PlayQueuesService);

	const pathFilter = function (path: string, req: any) {
		return shouldProxy(path, req.query, {
			proxyEnabled: PROXY.enabled,
			sections,
			playQueueMissing: req.flexPlayQueueMissing === true,
		});
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

	// Before routing: keep the virtual sections fresh, and flag play queues Flex does not hold so they go to Plex
	app.use(async (req: any, res: any, next: any) => {
		try {
			if (PROXY.enabled) {
				await sections.refreshIfStale();
				const playQueueId = /^\/playQueues\/(\d+)/.exec(req.path)?.[1];
				req.flexPlayQueueMissing = !!playQueueId && !(await playQueues.getPlayQueue(Number(playQueueId)));
			}
		} catch (error: any) {
			console.error(`Could not prepare request routing: ${error?.message ?? error}`);
		}
		next();
	});

	// Global proxy for ALL requests
	app.use(
		createProxyMiddleware({
			target: TARGET_URL,
			changeOrigin: true, // Rewrites the host header to match the target
			secure: true,       // Set to false if target uses self-signed SSL certs
			pathFilter: pathFilter,
			on: {
				// Essential hook to fix hanging POST/PUT requests caused by body-parsers
				proxyReq: fixRequestBody,
				// Only logs, so the response streams through. responseInterceptor() would hold the whole body in memory,
				// which for transcodes and long lived streams like /:/eventsource/notifications grows until the request ends.
				proxyRes: (proxyRes: any, req: any) => {
					console.debug(`${req.method} ${req.path} -> ${proxyRes.req.protocol}//${proxyRes.req.host}${proxyRes.req.path} [${proxyRes.statusCode}]`);
				},
			},
		}),
	);

	const port = process.env.FLEX_PORT ?? 32404;
	await app.listen(port);
	console.log(`Started on port ${port}`)
}
await bootstrap();
