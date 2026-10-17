import { Readable, pipeline } from 'node:stream';
import type { ServerResponse } from 'node:http';

type UpstreamResponse = { status: number; headers: Headers; _data?: unknown };

//ofetch throws on an error status without reading a stream body, which keeps that connection to Plex open until it is
//garbage collected. As an onResponseError hook this cancels the body, including for each attempt that gets retried.
export function cancelUnreadBody({ options, response }: { options: { responseType?: string }; response: Response }): void {
	if (options.responseType === 'stream') response.body?.cancel().catch(() => {});
}

//Streams a Plex response body to the client without buffering it.
//pipeline() rather than pipe(): when the client goes away (every seek drops the previous range request) it destroys the
//upstream stream, which cancels the request to Plex. pipe() would leave it open, holding its socket and buffered data.
export function streamUpstream(upstream: UpstreamResponse, res: ServerResponse, headers: Record<string, string | undefined> = {}): void {
	//The client can leave while Plex is still responding. pipeline() refuses a closed response, so the body is cancelled here.
	if (res.destroyed) {
		(upstream._data as ReadableStream | undefined)?.cancel().catch(() => {});
		return;
	}

	res.statusCode = upstream.status;

	for (const [name, value] of Object.entries(headers)) {
		if (value !== undefined) res.setHeader(name, value);
	}

	//fetch decodes a compressed body, so Plex's Content-Length would not match the bytes sent
	if (upstream.headers.get('content-encoding')) res.removeHeader('Content-Length');

	if (!upstream._data) {
		res.end();
		return;
	}

	pipeline(Readable.fromWeb(upstream._data as any), res, (error: any) => {
		//The client closing the connection is how playback normally ends, so only real failures are logged
		if (error && error.code !== 'ERR_STREAM_PREMATURE_CLOSE') console.error(`Streaming from Plex failed: ${error.message}`);
	});
}
