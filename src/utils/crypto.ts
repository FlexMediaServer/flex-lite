import crypto from 'crypto';

const DEFAULT_CONST = Buffer.alloc(16, 0x2a);

function buildSeed(constant: Buffer) {
	if (!Buffer.isBuffer(constant) || constant.length !== 16) {
		throw new Error('CONST must be exactly 16 bytes');
	}

	const SEED_STRING = Buffer.from(process.env.PLEX_SERVICE_TOKEN_SEED as string, 'base64');


	const seed = Buffer.from(SEED_STRING.subarray(0, 32));

	for (let i = 0; i < 16; i += 1) {
		seed[i] ^= constant[i];
		seed[i + 16] ^= constant[i];
	}

	return seed;
}

function deriveKeyIv(seed: Buffer) {
	let digest = Buffer.alloc(0);
	let prev = Buffer.alloc(0);

	while (digest.length < 48) {
		prev = crypto
			.createHash('md5')
			.update(Buffer.concat([prev, seed]))
			.digest();
		digest = Buffer.concat([digest, prev]);
	}

	const key = digest.subarray(0, 32);
	const iv = digest.subarray(32, 48);
	return { key, iv };
}

function pkcs7Unpad(data: Buffer) {
	if (!Buffer.isBuffer(data) || data.length === 0) {
		throw new Error('Invalid padding');
	}

	const pad = data[data.length - 1];
	if (pad < 1 || pad > 16) {
		throw new Error('Invalid padding');
	}

	const tail = data.subarray(data.length - pad);
	for (let i = 0; i < tail.length; i += 1) {
		if (tail[i] !== pad) {
			throw new Error('Invalid padding');
		}
	}

	return data.subarray(0, data.length - pad);
}

function trimTrailingControlBytes(data: Buffer) {
	let end = data.length;
	while (end > 0 && data[end - 1] < 0x20) {
		end -= 1;
	}
	return data.subarray(0, end);
}

function decryptToken(tokenB64: string, constant: Buffer) {
	const seed = buildSeed(constant);
	const { key, iv } = deriveKeyIv(seed);

	const ciphertext = Buffer.from(tokenB64, 'base64');
	if (ciphertext.length % 16 !== 0) {
		throw new Error('Ciphertext length is not a multiple of AES block size');
	}

	const decipher = crypto.createDecipheriv('aes-256-cbc', key, iv);
	decipher.setAutoPadding(false);
	const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

	let output;
	try {
		output = pkcs7Unpad(plaintext);
	} catch {
		output = plaintext;
	}

	output = trimTrailingControlBytes(output);

	return { seed, key, iv, output };
}

export function decryptPlexToken(token: string): string {
	const { output } = decryptToken(token, DEFAULT_CONST);
	return output.toString();
}
