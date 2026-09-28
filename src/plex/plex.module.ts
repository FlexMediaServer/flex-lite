import { forwardRef, Module } from '@nestjs/common';
import { PMSService } from './plex.service.js';
import { WebdavModule } from '../webdav/webdav.module.js';
import { MetadataModule } from '../metadata/metadata.module.js';
import { StremioModule } from '../stremio/stremio.module.js';

@Module({
  imports: [WebdavModule, forwardRef(() => MetadataModule),  forwardRef(() => StremioModule)],
  providers: [PMSService],
  exports: [PMSService]
})
export class PlexModule {}
