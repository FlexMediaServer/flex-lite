import { afterEach, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { ofetch } from 'ofetch';
import { cancelUnreadBody, streamUpstream } from './upstream-stream.js';

const servers: http.Server[] = [];

afterEach(() => {
	for (const server of servers.splice(0)) {
		server.closeAllConnections();
		server.close();
	}
});

//Starts a server and returns its url, plus the sockets currently open to it
async function serve(handler: (res: http.ServerResponse) => void): Promise<{ url: string; sockets: Set<unknown> }> {
	const sockets = new Set<unknown>();
	const server = http.createServer((_req, res) => handler(res));
	server.on('connection', (socket) => {
		sockets.add(socket);
		socket.on('close', () => sockets.delete(socket));
	});
	servers.push(server);

	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, sockets };
}

async function waitFor(condition: () => boolean, timeout = 2000) {
	const start = Date.now();
	while (!condition()) {
		if (Date.now() - start > timeout) throw new Error('Timed out waiting for condition');
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

//Configured like PMSService.plexServerApi
const plexApi = (url: string) =>
	ofetch.create({ baseURL: url, retry: 2, retryDelay: 0, retryStatusCodes: [500], onResponseError: cancelUnreadBody });

//Plex streaming a file that never ends, like a long direct play
const endlessFile = (status = 200) => (res: http.ServerResponse) => {
	res.writeHead(status, { 'Content-Type': 'video/x-matroska' });
	const write = () => {
		while (res.write(Buffer.alloc(64 * 1024)));
	};
	res.on('drain', write);
	write();
};

function upstream(body: ReadableStream | undefined, headers: Record<string, string> = {}, status = 200) {
	return { status, headers: new Headers(headers), _data: body };
}

describe('streamUpstream', () => {
	it('sends the body, status and headers', async () => {
		const { url } = await serve((res) =>
			streamUpstream(
				upstream(new Blob(['#EXTM3U\n', 'segment.ts\n']).stream(), {}, 206),
				res,
				{ 'Content-Type': 'application/vnd.apple.mpegurl', 'Content-Range': undefined },
			),
		);

		const response = await fetch(url);

		expect(response.status).toBe(206);
		expect(response.headers.get('content-type')).toBe('application/vnd.apple.mpegurl');
		expect(response.headers.has('content-range')).toBe(false);
		expect(await response.text()).toBe('#EXTM3U\nsegment.ts\n');
	});

	it('drops Content-Length when fetch has decoded a compressed body', async () => {
		const { url } = await serve((res) =>
			streamUpstream(upstream(new Blob(['decoded']).stream(), { 'content-encoding': 'gzip' }), res, { 'Content-Length': '3' }),
		);

		const response = await fetch(url);

		expect(response.headers.has('content-length')).toBe(false);
		expect(await response.text()).toBe('decoded');
	});

	it('ends the response when Plex sends no body', async () => {
		const { url } = await serve((res) => streamUpstream(upstream(undefined, {}, 204), res));

		const response = await fetch(url);

		expect(response.status).toBe(204);
	});

	it('closes the connection to Plex when the client goes away', async () => {
		const plex = await serve(endlessFile());
		const flex = await serve(async (res) => streamUpstream(await plexApi(plex.url).raw('/library/parts/1/file.mkv', { responseType: 'stream' }), res));

		const client = new AbortController();
		const response = await fetch(flex.url, { signal: client.signal });
		await response.body!.getReader().read();
		expect(plex.sockets.size).toBe(1);

		client.abort();

		await waitFor(() => plex.sockets.size === 0);
	});

	it('closes the connection to Plex when the client is gone before Plex responds', async () => {
		const plex = await serve(endlessFile());
		let responded!: () => void;
		const plexResponded = new Promise<void>((resolve) => (responded = resolve));

		const client = new AbortController();
		const flex = await serve(async (res) => {
			client.abort();
			await new Promise((resolve) => res.once('close', resolve));

			streamUpstream(await plexApi(plex.url).raw('/library/parts/1/file.mkv', { responseType: 'stream' }), res);
			responded();
		});

		await expect(fetch(flex.url, { signal: client.signal })).rejects.toThrow();
		await plexResponded;

		await waitFor(() => plex.sockets.size === 0);
	});

	it('closes the connection to Plex for each failed attempt', async () => {
		let attempts = 0;
		const plex = await serve((res) => {
			attempts++;
			endlessFile(500)(res);
		});

		await expect(plexApi(plex.url).raw('/library/parts/1/file.mkv', { responseType: 'stream' })).rejects.toThrow();

		expect(attempts).toBe(3);
		await waitFor(() => plex.sockets.size === 0);
	});
});
