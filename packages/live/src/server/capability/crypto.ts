export function webCrypto(): Crypto {
	if (!globalThis.crypto?.subtle) {
		throw new Error("Neon Live authorization requires Web Crypto");
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

export function asBufferSource(value: Uint8Array): ArrayBuffer {
	return new Uint8Array(value).buffer;
}

export function encodeHex(value: Uint8Array): string {
	return [...value]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}
