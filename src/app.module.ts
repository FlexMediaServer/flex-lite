import { MiddlewareConsumer, Module } from '@nestjs/common';
import { createObserveModule } from '@nestjs/observe';
import { AppController } from './app.controller.js';
import { AppService } from './app.service.js';
import { WebdavModule } from './webdav/webdav.module.js';
import { LoggerMiddleware } from './middleware/logger.middleware.js';
import { ProvidersModule } from './providers/providers.module.js';
import { MetadataModule } from './metadata/metadata.module.js';
import { PlayQueuesModule } from './play-queues/play-queues.module.js';
import { PlexModule } from './plex/plex.module.js';
import { StremioModule } from './stremio/stremio.module.js';
import { XPlexMiddleware } from './middleware/x-plex.middleware.js';
import { ClientIdentifier } from './middleware/client-identifier.middleware.js';

export const { ObserveModule, ObserveInstrument } = createObserveModule();

@Module({
  imports: [
    // Distributed tracing, auto-correlated logs, request/job metrics, error
    // telemetry, alarms, and more — out of the box. Sign up at https://observe.nestjs.com
    // ObserveModule.forRoot({
    //   appKey: 'YOUR_APP_KEY',
    //   appSecret: 'YOUR_APP_SECRET',
    //   serviceId: 'flex-lite',
    // }),
    WebdavModule,
    ProvidersModule,
    MetadataModule,
    PlayQueuesModule,
    PlexModule,
    StremioModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {
	configure(consumer: MiddlewareConsumer) {
		consumer.apply(LoggerMiddleware).forRoutes('*');
		consumer.apply(XPlexMiddleware).forRoutes('*');
		consumer.apply(ClientIdentifier).forRoutes('*');
	}
}
