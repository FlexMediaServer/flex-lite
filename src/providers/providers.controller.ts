import { Controller, Get, Headers, Query, UseGuards } from '@nestjs/common';
import axios from 'axios';
import { LoggedInGuard } from '../middleware/logged-in.guard.js';

@Controller('')
// @UseGuards(LoggedInGuard)
export class ProvidersController {
	endpoint = process.env.PLEX_BASE ?? 'http://localhost:32400';

	@Get('/media/providers')
	async providers (@Headers() headers: any, @Query() query: any) {
		try {
			let response = await axios.get(`${this.endpoint}/media/providers`, {
				headers: headers,
				params: query
			});
			
			return response.data
		} catch (e) {}
	}
}
