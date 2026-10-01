import { forwardRef, Module } from '@nestjs/common';
import { PlayQueuesController } from './play-queues.controller.js';
import { PlayQueuesService } from './play-queues.service.js';
import { MetadataModule } from '../metadata/metadata.module.js';
import { StremioModule } from '../stremio/stremio.module.js';
import { PlexModule } from '../plex/plex.module.js';
import { AppModule } from '../app.module.js';

@Module({
  imports: [MetadataModule, StremioModule, PlexModule, forwardRef(() => AppModule)],
  controllers: [PlayQueuesController],
  providers: [PlayQueuesService]
})
export class PlayQueuesModule {}
