import { forwardRef, Module } from '@nestjs/common';
import { PMSService } from './plex.service.js';
import { PlexNotificationsGateway } from './plex-notifications.gateway.js';
import { SectionsService } from './sections.service.js';
import { MetadataModule } from '../metadata/metadata.module.js';
import { StremioModule } from '../stremio/stremio.module.js';

@Module({
  imports: [forwardRef(() => MetadataModule),  forwardRef(() => StremioModule)],
  providers: [PMSService, PlexNotificationsGateway, SectionsService],
  exports: [PMSService, SectionsService]
})
export class PlexModule {}
