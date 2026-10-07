const SECRET_PREFIX = "nrt_live_1";
const KEY_BYTES = 32;

export interface RealtimeSecret {
	readonly key: Uint8Array;
}

/**
 * Decode the opaque credential issued for one Realtime project.
 *
 * Applications configure one server-only value. Its representation is not a
 * public application data format and may only be interpreted by this SDK.
 */
export function parseRealtimeSecret(secret: string): RealtimeSecret {
	try {
		if (!secret.startsWith(SECRET_PREFIX)) throw new Error();
		const encodedKey = secret.slice(SECRET_PREFIX.length);
		const key = decodeBase64Url(encodedKey);
		if (key.length !== KEY_BYTES || encodeBase64Url(key) !== encodedKey) {
			throw new Error();
		}
		return Object.freeze({ key });
	} catch {
		throw new Error("Invalid Realtime secret");
	}
}

function decodeBase64Url(value: string): Uint8Array {
	if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error();
	const standard = value.replace(/-/g, "+").replace(/_/g, "/");
	const binary = atob(standard + "=".repeat((4 - (standard.length % 4)) % 4));
	return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function encodeBase64Url(value: Uint8Array): string {
	let binary = "";
	for (let offset = 0; offset < value.length; offset += 0x8000) {
		binary += String.fromCharCode(
			...value.subarray(offset, offset + 0x8000),
		);
	}
	return btoa(binary)
		.replace(/\+/g, "-")
		.replace(/\//g, "_")
		.replace(/=+$/, "");
}
