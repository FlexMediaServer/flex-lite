import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { ClientType } from '../middleware/client-identifier.middleware.js';

export const Client = createParamDecorator(
	(data: unknown, ctx: ExecutionContext): ClientType => {
		const request = ctx.switchToHttp().getRequest();
		return request.clientType as ClientType;
	},
);
