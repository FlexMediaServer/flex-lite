import { ofetch } from 'ofetch';

//Returns true when a GET request to the URL succeeds with a 2xx or 206 status within the timeout.
export async function probeUrl (url: string, timeoutMs: number = 30000): Promise<boolean> {
	try {
		const response = await ofetch.raw(url, {
			method: 'GET',
			headers: {
				Range: 'bytes=0-1000',
			},
			timeout: timeoutMs,
			redirect: 'follow',
			ignoreResponseError: true,
		});

		if (!response.ok) {
			console.error(`Probe of ${url} failed with status ${response.status}`);
		}

		return response.ok;
	} catch (error: any) {
		console.error(`Probe of ${url} failed: ${error?.message ?? error}`);
		return false;
	}
}


