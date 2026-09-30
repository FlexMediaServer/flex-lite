import { Controller, Get, Head, HttpCode, Query, Req, Res, StreamableFile } from '@nestjs/common';
import { AppService } from './app.service.js';
import type express from 'express';
import { createReadStream, stat } from 'fs';
import { promisify } from 'util';

@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Get('/dummy.mkv')
  async dummyFile (@Req() req: any, @Res({ passthrough: true }) res: any) {
	if (req.method === 'HEAD') {
		const fileStats = await promisify(stat)('./dummy.mp4');
		res.header('Content-Length', fileStats.size.toString());
		return;
	} else {
		const fileStream = createReadStream('./dummy.mp4');
		return new StreamableFile(fileStream);
	}
  }
}
