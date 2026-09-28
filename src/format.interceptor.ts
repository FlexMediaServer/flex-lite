import { Injectable, NestInterceptor, ExecutionContext, CallHandler, StreamableFile } from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';

import { toXML } from 'to-xml';
import { convertBooleansToInts } from './utils/generic.js';
import { instanceToPlain } from 'class-transformer';
import type { Request, Response as ExpressResponse } from 'express';
import { toRequestListString } from './utils/request-values.js';

type XmlSerializable = Record<string, unknown>;

function isRecord(value: unknown): value is XmlSerializable {
	return typeof value === 'object' && value !== null;
}

function escapeXmlString(value: string) {
	// Strip invalid XML 1.0 control chars, then escape reserved symbols.
	return value
		.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&apos;');
}

export function convertToXMLJSON(obj: unknown): XmlSerializable {
	const object: XmlSerializable = {};

	if (!isRecord(obj)) {
		return object;
	}

	for (const key in obj) {
		const value = obj[key];

		if (value === null || value === undefined) {
			continue;
		}

		if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
			object[key] = escapeXmlString(value.join(','));
		} else if (!Array.isArray(value) && typeof value !== 'object') {
			object[`@${key}`] = typeof value === 'string' ? escapeXmlString(value) : value;
		} else if (Array.isArray(value)) {
			object[key] = value.map((item) => {
				if (item === null || item === undefined) return item;
				if (typeof item === 'string') return escapeXmlString(item);
				if (typeof item === 'object') return convertToXMLJSON(item);
				return item;
			});
		} else if (typeof value === 'object') {
			object[key] = convertToXMLJSON(value);
		}
	}

	return object;
}

export function convertToXML(obj: unknown) {
	return toXML(convertToXMLJSON(obj), undefined, 0);
}

export interface Response<T> {
	data: T;
}

function serializeEntity<T>(data: T): T {
	if (data instanceof StreamableFile) {
		return data;
	}

	const serializeValue = (value: unknown): unknown => {
		if (value === null || value === undefined) {
			return value;
		}

		if (Array.isArray(value)) {
			return value.map((item) => serializeValue(item));
		}

		if (typeof value !== 'object') {
			return value;
		}

		const plain = instanceToPlain(value as object);
		if (plain === null || plain === undefined) {
			return plain;
		}

		if (Array.isArray(plain)) {
			return plain.map((item) => serializeValue(item));
		}

		if (typeof plain !== 'object') {
			return plain;
		}

		const output: Record<string, unknown> = {};
		for (const [key, nestedValue] of Object.entries(plain)) {
			output[key] = serializeValue(nestedValue);
		}

		return output;
	};

	return serializeValue(data) as T;
}

@Injectable()
export class FormatInterceptor<T> implements NestInterceptor<T, Response<T>> {
	intercept(context: ExecutionContext, next: CallHandler): Observable<Response<T>> {
		const request = context.switchToHttp().getRequest() as Request;

		if (request.path.startsWith('/video/:/transcode/universal/start')) return next.handle();

		const accept = toRequestListString(request.query['accept'] || request.query['Accept'] || request.headers['accept'] || request.headers['Accept']);

		if (accept && accept.split(',').includes('application/json')) {
			return next.handle().pipe(map((data) => serializeEntity(data)));
		} else {
			return next
				.handle()
				.pipe(map((data) => serializeEntity(data)))
				.pipe(
					map((data) => {
						if (data instanceof StreamableFile) {
							return data;
						}

						const response = context.switchToHttp().getResponse<ExpressResponse>();
						if (isRecord(data)) {
							response.setHeader('Content-Type', 'text/xml;charset=utf-8');
							return convertToXML(convertBooleansToInts(data));
						} else {
							return data;
						}
					}),
				);
		}
	}
}
