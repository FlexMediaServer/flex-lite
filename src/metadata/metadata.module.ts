import { forwardRef, Module } from '@nestjs/common';
import { MetadataController } from './metadata.controller.js';
import { ResolveController } from './resolve.controller.js';
import { MetadataService } from './metadata.service.js';
import { PlexModule } from '../plex/plex.module.js';
import { StremioModule } from '../stremio/stremio.module.js';
import { AppModule } from '../app.module.js';
import { ScrobblingModule } from '../scrobbling/scrobbling.module.js';

@Module({
  imports: [PlexModule, StremioModule, forwardRef(() => AppModule), ScrobblingModule],
  controllers: [MetadataController, ResolveController],
  providers: [MetadataService],
  exports: [MetadataService]
})
export class MetadataModule {}
