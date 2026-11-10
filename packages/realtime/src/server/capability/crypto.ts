export function webCrypto(): Crypto {
	if (!globalThis.crypto?.subtle) {
		throw new Error("Live-query sealing requires Web Crypto");
	}
	return globalThis.crypto;
}

export function utf8(value: string): Uint8Array {
	return new TextEncoder().encode(value);
}

export function concatBytes(...parts: readonly Uint8Array[]): Uint8Array {
	const output = new Uint8Array(
		parts.reduce((size, part) => size + part.length, 0),
	);
	let offset = 0;
	for (const part of parts) {
		output.set(part, offset);
		offset += part.length;
	}
	return output;
}

export function encodeBase64(value: Uint8Array): string {
	let binary = "";
	for (let offset = 0; offset < value.length; offset += 0x8000) {
		binary += String.fromCharCode(
			...value.subarray(offset, offset + 0x8000),
		);
	}
	return btoa(binary);
}

export function encodeBase64Url(value: Uint8Array): string {
	return encodeBase64(value)
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
}

/**
 * Decode unpadded base64url, rejecting padding, other characters and
 * non-zero unused trailing bits, so each byte string has one encoding.
 */
export function decodeBase64UrlStrict(value: string): Uint8Array {
	if (!/^[A-Za-z0-9_-]*$/.test(value) || value.length % 4 === 1) {
		throw new Error("Invalid base64url");
	}
	const standard = value.replace(/-/g, "+").replace(/_/g, "/");
	const binary = atob(standard + "=".repeat((4 - (standard.length % 4)) % 4));
	const decoded = Uint8Array.from(binary, (character) =>
		character.charCodeAt(0),
	);
	if (encodeBase64Url(decoded) !== value)
		throw new Error("Invalid base64url");
	return decoded;
}

export function asBufferSource(value: Uint8Array): ArrayBuffer {
	return new Uint8Array(value).buffer;
}

export function encodeHex(value: Uint8Array): string {
	return [...value]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}
