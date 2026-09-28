export function convertBooleansToInts(obj: any) {
	// Check if the input is an object or an array
	if (obj && typeof obj === 'object') {
		// Iterate over the object's keys
		for (const key in obj) {
			if (Object.hasOwn(obj, key)) {
				if (typeof obj[key] === 'boolean') {
					// Convert boolean to integer
					obj[key] = obj[key] ? 1 : 0;
				} else if (typeof obj[key] === 'object') {
					// Recursively process nested objects or arrays
					convertBooleansToInts(obj[key]);
				}
			}
		}
	}
	return obj;
}

export function generateHash(string: string) {
	let hash = 0;
	for (const char of string) {
		hash = (hash << 5) - hash + char.charCodeAt(0);
		hash |= 0; // Constrain to 32bit integer
	}
	return hash >>> 0;
}

export function parseKey(key: string): { itemId: string } {
	const parsedPath = key.split('/');
	const metadataIndex = parsedPath.findIndex((part) => part === 'metadata');

	return {
		itemId: parsedPath[metadataIndex + 1],
	};
}

export function toLowerCaseKeys(obj: any) {
	if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
		return obj;
	}

	return Object.keys(obj).reduce((acc: any, key) => {
		const lowerCaseKey = key.toLowerCase();
		acc[lowerCaseKey] = typeof obj[key] === 'object' && !Array.isArray(obj[key]) ? toLowerCaseKeys(obj[key]) : obj[key];
		return acc;
	}, {});
}
