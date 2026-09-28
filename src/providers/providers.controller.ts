import { Controller, Get, Headers, Query } from '@nestjs/common';
import axios from 'axios';

@Controller('')
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
