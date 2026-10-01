import { forwardRef, Module } from '@nestjs/common';
import { MetadataController } from './metadata.controller.js';
import { MetadataService } from './metadata.service.js';
import { PlexModule } from '../plex/plex.module.js';
import { StremioModule } from '../stremio/stremio.module.js';
import { AppModule } from '../app.module.js';

@Module({
  imports: [PlexModule, StremioModule, forwardRef(() => AppModule)],
  controllers: [MetadataController],
  providers: [MetadataService],
  exports: [MetadataService]
})
export class MetadataModule {}
