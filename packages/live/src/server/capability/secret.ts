const SECRET_PREFIX = "neon_live_v1_";
const KEY_BYTES = 32;
const KID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export interface RealtimeSecret {
	readonly key: Uint8Array;
	readonly keyId: string;
	readonly issuer: string;
}

/**
 * Decode the opaque credential issued for one Realtime project.
 *
 * The credential deliberately packages key-selection metadata with the key so
 * applications configure one server-only value. Its representation is not a
 * public application data format and may only be interpreted by this SDK.
 */
export function parseRealtimeSecret(secret: string): RealtimeSecret {
	try {
		if (!secret.startsWith(SECRET_PREFIX)) throw new Error();
		const payload = JSON.parse(
			new TextDecoder("utf-8", { fatal: true }).decode(
				decodeBase64Url(secret.slice(SECRET_PREFIX.length)),
			),
		) as unknown;
		if (!isRecord(payload)) throw new Error();
		if (
			Object.keys(payload).sort().join(",") !== "iss,key,kid,v" ||
			payload.v !== 1 ||
			typeof payload.kid !== "string" ||
			!KID_PATTERN.test(payload.kid) ||
			typeof payload.iss !== "string" ||
			!validIssuer(payload.iss) ||
			typeof payload.key !== "string"
		) {
			throw new Error();
		}
		const key = decodeBase64Url(payload.key);
		if (key.length !== KEY_BYTES || encodeBase64Url(key) !== payload.key) {
			throw new Error();
		}
		return Object.freeze({
			key,
			keyId: payload.kid,
			issuer: payload.iss,
		});
	} catch {
		throw new Error("Invalid Realtime secret");
	}
}

function validIssuer(value: string): boolean {
	const bytes = new TextEncoder().encode(value);
	return bytes.length > 0 && bytes.length <= 255 && !value.includes("\0");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
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
