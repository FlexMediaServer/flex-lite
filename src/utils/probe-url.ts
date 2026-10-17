import { ofetch } from 'ofetch';

//Returns true when a HEAD request to the URL succeeds with a 2xx status within the timeout.
export async function probeUrl (url: string, timeoutMs: number = 5000): Promise<boolean> {
	try {
		const response = await ofetch.raw(url, {
			method: 'HEAD',
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


