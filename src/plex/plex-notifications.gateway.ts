import { WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import { WebSocket, type Server } from 'ws';
import { PMSService } from './plex.service.js';
import { IncomingMessage } from 'http';

export const PLEX_NOTIFICATIONS_PATH = '/:/websockets/notifications';

// Client connections, tagged with the parsed query params from their upgrade request
type ProxiedClient = WebSocket & { queryParams?: Record<string, string> };

// Proxies Plex's persistent notifications socket: each client connection gets
// its own upstream connection and frames are forwarded both ways.
@WebSocketGateway({
	path: PLEX_NOTIFICATIONS_PATH,
})
export class PlexNotificationsGateway {
	@WebSocketServer()
	server: Server;

	constructor(private readonly pmsService: PMSService) {}

	handleConnection(client: ProxiedClient, request: IncomingMessage) {
		// Build the upstream Plex URL from the client's requested path + query
		const url = new URL(request.url ?? PLEX_NOTIFICATIONS_PATH, this.pmsService.endpoint.replace(/^http/, 'ws'));

		// Automatically convert all search parameters into a clean key-value object
		const queryParams = Object.fromEntries(url.searchParams.entries());

		// Attach the parsed params to the client object for easy access in your handlers/guards
		client.queryParams = queryParams;

		// Plex requires a token on the notifications socket
		if (!url.searchParams.has('X-Plex-Token') && this.pmsService.plexToken) {
			url.searchParams.set('X-Plex-Token', this.pmsService.plexToken);
		}

		const upstream = new WebSocket(url.toString());

		upstream.on('open', () => {
			client.on('message', (data, isBinary) => {
				if (upstream.readyState === WebSocket.OPEN) {
					upstream.send(data as Buffer, { binary: isBinary });
				}
			});
		});

		upstream.on('message', (data, isBinary) => {
			if (client.readyState === WebSocket.OPEN) {
				client.send(data as Buffer, { binary: isBinary });
			}
		});

		upstream.on('close', () => client.close());
		upstream.on('error', () => client.close());
		client.on('close', () => upstream.close());
	}
}
