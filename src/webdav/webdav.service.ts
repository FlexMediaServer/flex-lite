import { Injectable } from '@nestjs/common';
import axios from 'axios';
import path from 'path';

export type Folder = {
	[children: string]: Folder | File
}

export type File = {
	id: string;
	url: string
	sourceUrl: string;
	contentLength: string;
}

@Injectable()
export class WebdavService {
	folders: Folder = {}

	async onModuleInit () {}

	/**
	 * Gets a value at the specified path
	 * @param path - Path like 'Shows/Show Name/Season 1'
	 */
	getPath(path: string): Folder | File | undefined {
		const keys = path.split('/').filter(Boolean).map(part => decodeURIComponent(part));
		
		let current: any = this.folders;
		for (const key of keys) {
			if (current && typeof current === 'object' && key in current) {
				current = current[key];
			} else {
				return undefined;
			}
		}
		return current;
	}

	/**
	 * Sets a value at the specified path, creating intermediate folders if needed
	 * @param path - Path like 'Shows/Show Name/Season 1'
	 * @param value - Value to set (Folder or File)
	 */
	setPath(path: string, value: any): void {
		const keys = path.split('/').filter(Boolean).map(part => decodeURIComponent(part));
		
		if (keys.length === 0) {
			// Setting root
			Object.assign(this.folders, value);
			return;
		}

		let current: any = this.folders;
		for (let i = 0; i < keys.length - 1; i++) {
			const key = keys[i];
			if (!(key in current)) {
				current[key] = {};
			}
			current = current[key];
		}

		// Set the final key
		const finalKey = keys[keys.length - 1];
		current[finalKey] = value;
	}

	/**
	 * Adds a file to the specified folder path
	 * @param url - The stream URL to add
	 * @param folderPath - The folder path where the file should be stored
	 */
	public async addFile(path: string = '', url: string): Promise<File> {
		console.log('[WEBDAV] Adding stream to path:', path, url);
		const resolved = await this.resolveUrl(url);
		
		// Create the file object
		const file: File = {
			id: resolved.id,
			url: resolved.url,
			sourceUrl: resolved.sourceUrl,
			contentLength: resolved.contentLength
		};

		// Set the file at the specified path
		this.setPath(path, file);
		
		console.debug(`Added stream: ${path}`);
		return file;
	}

	async generateHashId(data: any) {
		const encoder = new TextEncoder();
		const msgBuffer = encoder.encode(data);
		const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
		const hashArray = Array.from(new Uint8Array(hashBuffer));
		const hashHex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
		return hashHex;
	}

	async resolveUrl (url: string) {
		let head = await axios.head(url, {
			maxRedirects: 5,
			validateStatus: (status) => status >= 200 && status < 400
		});

		const finalUrl = head.request.res.responseUrl;

		return {
			id: await this.generateHashId(url) + '.' + url.split('.').pop(),
			sourceUrl: url,
			contentLength: head.headers['content-length'] as string,
			url: finalUrl
		};
	}

}
