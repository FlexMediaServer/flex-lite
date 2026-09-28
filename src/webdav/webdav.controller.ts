
import { Body, Controller, Options, Propfind, Res, Param, Get, Head, Res as Response, Delete } from '@nestjs/common';
import axios from 'axios';
import type express from 'express';
import { WebdavService, type Folder, type File } from './webdav.service.js';

@Controller('webdav')
export class WebdavController {

	constructor(private webdavService: WebdavService) {}

	@Propfind(['/{*path}', '/'])
	async propFind(@Body() body: any, @Res({ passthrough: true }) res: express.Response, @Param() params: any) {
		res.header('Content-Type', 'text/xml');

		// Normalize the path - remove leading slash and split
		const rawPath = params.path ? (Array.isArray(params.path) ? params.path.join('/') : params.path) : '';
		const pathSegments = rawPath.split('/').filter(Boolean);

		// Check if path ends with trailing slash (indicates folder)
		const isFolderRequest = rawPath.endsWith('/') || rawPath === '';

		const item = this.webdavService.getPath(rawPath);

		// console.log('Path:', rawPath, 'IsFolder:', isFolderRequest, 'Item:', item);

		if (!item) {
			res.status(404);
			return `<?xml version="1.0" encoding="utf-8"?>
<multistatus xmlns="DAV:">
  <response>
    <status>HTTP/1.1 404 Not Found</status>
  </response>
</multistatus>`;
		}

		// Check if it's a file (has url property)
		const isFile = 'url' in item;

		// If requesting a file as a folder (or vice versa), return appropriate error
		if (isFolderRequest && isFile) {
			res.status(404);
			return `<?xml version="1.0" encoding="utf-8"?>
<multistatus xmlns="DAV:">
  <response>
    <status>HTTP/1.1 404 Not Found</status>
  </response>
</multistatus>`;
		}

		if (!isFolderRequest && !isFile) {
			res.status(404);
			return `<?xml version="1.0" encoding="utf-8"?>
<multistatus xmlns="DAV:">
  <response>
    <status>HTTP/1.1 404 Not Found</status>
  </response>
</multistatus>`;
		}

		// Handle folder listing
		if (isFolderRequest && !isFile) {
			const folder = item as Folder;
			const folderPath = rawPath;

			const responses = Object.keys(folder).map(name => {
				const folderItem = folder[name];
				const isSubFolder = typeof folderItem === 'object' && !('url' in folderItem);
				const href = isSubFolder ? `/webdav/${folderPath}${name}/` : `/webdav/${folderPath}${name}`;
				const resourceType = isSubFolder ? '<resourcetype><collection/></resourcetype>' : '<resourcetype/>';
				const fileProps = !isSubFolder ? `
        <getlastmodified>Tue, 15 Sep 2026 12:00:00 GMT</getlastmodified>
				<getcontentlength>${(folderItem as File).contentLength}</getcontentlength>
				<getcontenttype>application/octet-stream</getcontenttype>` : '';

				return `<response>
    <href>${href}</href>
    <propstat>
      <prop>
        <displayname>${name}</displayname>
        ${resourceType}
        ${fileProps}
      </prop>
      <status>HTTP/1.1 200 OK</status>
    </propstat>
  </response>`;
			});

			return `<?xml version="1.0" encoding="utf-8"?>
<multistatus xmlns="DAV:">
${responses.join('\n')}
</multistatus>`;
		}

		// Handle file propfind
		if (!isFolderRequest && isFile) {
			const file = item as File;
			const fileName = pathSegments[pathSegments.length - 1];

			return `<?xml version="1.0" encoding="utf-8"?>
<multistatus xmlns="DAV:">
  <response>
    <href>/webdav/${rawPath}</href>
    <propstat>
      <prop>
        <displayname>${fileName}</displayname>
        <getlastmodified>Tue, 15 Sep 2026 12:00:00 GMT</getlastmodified>
			<getcontentlength>${file.contentLength}</getcontentlength>
			<getcontenttype>application/octet-stream</getcontenttype>
			<resourcetype/>
      </prop>
      <status>HTTP/1.1 200 OK</status>
    </propstat>
  </response>
</multistatus>`;
		}
	}



	@Get('/{*path}')
	getFile(@Res({ passthrough: true }) res: express.Response, @Param() params: any) {
		const file = this.webdavService.getPath(params.path.join('/'));
		const url = file?.url;

		if (url) {
			res.redirect(url as string);
		} else {
			res.status(404).send('File not found');
		}
	}

	@Delete('/{*path}')
	deleteFile(@Res({ passthrough: true }) res: express.Response, @Param() params: any) {
		
	}

}
