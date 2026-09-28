import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import { ClientType } from './client-identifier.middleware.js';

/**
 * Decorator to extract the client type from the request.
 * Use this decorator on controller method parameters to get the identified client type.
 * 
 * @example
 * ```typescript
 * @Get()
 * getData(@Client() clientType: ClientType) {
 *   return `Client type: ${clientType}`;
 * }
 * ```
 */
export const Client = createParamDecorator(
	(data: unknown, ctx: ExecutionContext): ClientType => {
		const request = ctx.switchToHttp().getRequest();
		return request.clientType as ClientType;
	},
);
