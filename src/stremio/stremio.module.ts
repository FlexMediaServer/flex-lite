import { forwardRef, Module } from '@nestjs/common';
import { StremioService } from './stremio.service.js';
import { MetadataModule } from '../metadata/metadata.module.js';

@Module({
  imports: [forwardRef(() => MetadataModule)],
  providers: [StremioService],
  exports: [StremioService]
})
export class StremioModule {}
