import { forwardRef, Module } from '@nestjs/common';
import { PlexModule } from '../plex/plex.module.js';
import { ScrobblingService } from './scrobbling.service.js';
import { MetadataModule } from '../metadata/metadata.module.js';

@Module({
  imports: [forwardRef(() => PlexModule), forwardRef(() => MetadataModule)],
  providers: [ScrobblingService],
  exports: [ScrobblingService]
})
export class ScrobblingModule {}
