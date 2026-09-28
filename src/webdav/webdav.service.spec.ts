import { Test, TestingModule } from '@nestjs/testing';
import { WebdavService } from './webdav.service.js';

describe('WebdavService', () => {
  let service: WebdavService;

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      providers: [WebdavService],
    }).compile();

    service = module.get<WebdavService>(WebdavService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });
});
