import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { toRequestListString } from './utils/request-values.js';

export const IsXML = createParamDecorator((data: unknown, ctx: ExecutionContext) => {
	const request = ctx.switchToHttp().getRequest();

	const accept = toRequestListString(request.query['accept'] || request.query['Accept'] || request.headers['accept'] || request.headers['Accept']);

	return !(accept && accept.split(',').includes('application/json'));
});
