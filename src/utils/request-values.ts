export type NormalizedQueryValue = string | number | boolean | undefined;

export function toRequestString(value: unknown): string | undefined {
	if (typeof value === 'string') {
		return value;
	}

	if (typeof value === 'number' || typeof value === 'boolean') {
		return String(value);
	}

	if (!Array.isArray(value)) {
		return undefined;
	}

	for (const item of value) {
		const stringValue = toRequestString(item);
		if (stringValue !== undefined) {
			return stringValue;
		}
	}

	return undefined;
}

export function toRequestListString(value: unknown): string | undefined {
	if (!Array.isArray(value)) {
		return toRequestString(value);
	}

	const values = value.map((item) => toRequestString(item)).filter((item): item is string => item !== undefined);

	return values.length > 0 ? values.join(',') : undefined;
}

export function toRequestStringRecord(entries: Iterable<[string, unknown]>): Record<string, string> {
	const values: Record<string, string> = {};

	for (const [key, value] of entries) {
		const stringValue = toRequestString(value);
		if (stringValue !== undefined) {
			values[key] = stringValue;
		}
	}

	return values;
}

function toNormalizedQueryValue(value: unknown): NormalizedQueryValue {
	if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
		return value;
	}

	if (!Array.isArray(value)) {
		return undefined;
	}

	for (const item of value) {
		const normalizedValue = toNormalizedQueryValue(item);
		if (normalizedValue !== undefined) {
			return normalizedValue;
		}
	}

	return undefined;
}

export function normalizeParams(value: unknown): Record<string, NormalizedQueryValue> {
	if (value instanceof URLSearchParams) {
		return Object.fromEntries(value.entries());
	}

	if (!value || typeof value !== 'object' || Array.isArray(value)) {
		return {};
	}

	const query: Record<string, NormalizedQueryValue> = {};

	for (const [key, entryValue] of Object.entries(value)) {
		const normalizedValue = toNormalizedQueryValue(entryValue);
		if (normalizedValue !== undefined) {
			query[key] = normalizedValue;
		}
	}

	return query;
}
