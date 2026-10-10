import { BadRequestException, Controller, Get, NotFoundException, Param, Redirect, UseGuards } from '@nestjs/common';
import { MetadataService } from './metadata.service.js';
import { AppService } from '../app.service.js';
import { LoggedInGuard } from '../middleware/logged-in.guard.js';

@Controller()
@UseGuards(LoggedInGuard)
export class ResolveController {
	constructor(
		private metadataService: MetadataService,
		private appService: AppService,
	) {}

	//Resolves a movie or episode to its local Plex media and redirects to the part file that media plays from.
	@Get('/resolve/:id')
	@Redirect()
	async resolve(@Param('id') id: string) {
		const item = await this.metadataService.getItem(id);
		if (!item) throw new NotFoundException();
		if (item.type !== 'movie' && item.type !== 'episode') throw new BadRequestException('Only movies and episodes can be resolved');

		const localItem = await this.appService.resolveMedia(item);
		const partKey = localItem?.Media?.[0]?.Part?.[0]?.key;
		if (!partKey) throw new NotFoundException();

		return { url: partKey, statusCode: 302 };
	}
}
