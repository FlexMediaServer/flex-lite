import { Controller, Get, Headers, Query, UseGuards } from '@nestjs/common';
import axios from 'axios';
import { LoggedInGuard } from '../middleware/logged-in.guard.js';
import { SectionsService } from '../plex/sections.service.js';

@Controller('')
// @UseGuards(LoggedInGuard)
export class ProvidersController {
	endpoint = process.env.PLEX_BASE ?? 'http://localhost:32400';

	constructor (private readonly sections: SectionsService) {}

	@Get('/media/providers')
	async providers (@Headers() headers: any, @Query() query: any) {
		try {
			let response = await axios.get(`${this.endpoint}/media/providers`, {
				headers: { ...headers, Accept: 'application/json' }, //Always fetch JSON; FormatInterceptor re-serializes to the client's format
				params: query
			});

			const mediaContainer = response.data?.MediaContainer;
			const providers = this.toArray(mediaContainer?.MediaProvider);

			for (const provider of providers)
				for (const feature of this.toArray(provider.Feature))
					for (const directory of this.toArray(feature.Directory)) {
						//Only virtual sections are Flex's; every other section stays real Plex
						if (!this.sections.isVirtual(directory.id)) continue;
						directory.Pivot = this.toArray(directory.Pivot).filter((pivot: any) => pivot?.symbol !== 'library' && pivot?.id !== 'categories');
					}

			return response.data
		} catch (e) {}
	}

	private toArray (value: any): any[] {
		if (value === undefined || value === null) return [];
		return Array.isArray(value) ? value : [value];
	}
}
