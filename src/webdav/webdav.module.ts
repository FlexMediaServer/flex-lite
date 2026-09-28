import { Module } from '@nestjs/common';
import { WebdavController } from './webdav.controller.js';
import { WebdavService } from './webdav.service.js';

@Module({
  controllers: [WebdavController],
  providers: [WebdavService],
  exports: [WebdavService]
})
export class WebdavModule {}
