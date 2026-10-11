import { forwardRef, Module } from '@nestjs/common';
import { ProvidersController } from './providers.controller.js';
import { PlexModule } from '../plex/plex.module.js';

@Module({
  imports: [forwardRef(() => PlexModule)],
  controllers: [ProvidersController]
})
export class ProvidersModule {}
