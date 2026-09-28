import { Test, TestingModule } from '@nestjs/testing';
import { WebdavController } from './webdav.controller.js';

describe('WebdavController', () => {
  let controller: WebdavController;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [WebdavController],
    }).compile();

    controller = module.get<WebdavController>(WebdavController);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });
});
