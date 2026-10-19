import type { PreparedLiveQuery } from "../adapter.js";
import {
	asBufferSource,
	concatBytes,
	encodeBase64,
	encodeHex,
	utf8,
	webCrypto,
} from "./crypto.js";

// Domain separation prevents reuse as an unrelated hash or a different fingerprint version.
const FINGERPRINT_DOMAIN = utf8("neon-live-query-fingerprint-v1\0");
const HKDF_SALT = utf8("neon-realtime-key-derivation-v1\0");
const PUBLIC_FINGERPRINT_KEY_DOMAIN =
	"neon-realtime-public-query-fingerprint-key-v2";
const PUBLIC_FINGERPRINT_DOMAIN = utf8(
	"neon-realtime-public-query-fingerprint-v2\0",
);

/** Compute the stable identity used to reject renewal with a different query. */
export async function queryFingerprint(
	query: PreparedLiveQuery,
): Promise<string> {
	const digest = await webCrypto().subtle.digest(
		"SHA-256",
		asBufferSource(
			concatBytes(FINGERPRINT_DOMAIN, canonicalQueryBytes(query)),
		),
	);
	return encodeHex(new Uint8Array(digest));
}

/** Derive a database-scoped key for the public v2 query fingerprint. */
export async function derivePublicQueryFingerprintKey(
	secret: Uint8Array,
	database: string,
): Promise<CryptoKey> {
	const source = await webCrypto().subtle.importKey(
		"raw",
		asBufferSource(secret),
		"HKDF",
		false,
		["deriveKey"],
	);
	return webCrypto().subtle.deriveKey(
		{
			name: "HKDF",
			hash: "SHA-256",
			salt: asBufferSource(HKDF_SALT),
			info: asBufferSource(
				utf8(
					JSON.stringify({
						purpose: PUBLIC_FINGERPRINT_KEY_DOMAIN,
						database,
					}),
				),
			),
		},
		source,
		{ name: "HMAC", hash: "SHA-256", length: 256 },
		false,
		["sign"],
	);
}

/** Compute the keyed identity exposed in a v2 sealed-query envelope. */
export async function publicQueryFingerprint(
	query: PreparedLiveQuery,
	key: CryptoKey,
): Promise<string> {
	const signature = await webCrypto().subtle.sign(
		"HMAC",
		key,
		asBufferSource(
			concatBytes(PUBLIC_FINGERPRINT_DOMAIN, canonicalQueryBytes(query)),
		),
	);
	return encodeHex(new Uint8Array(signature));
}

function canonicalQueryBytes(query: PreparedLiveQuery): Uint8Array {
	const canonical = {
		sql: query.sql,
		parameters: query.parameters.map((parameter) => ({
			type_oid: parameter.typeOid,
			value:
				parameter.value === null
					? null
					: encodeBase64(utf8(parameter.value)),
		})),
	};
	return utf8(JSON.stringify(canonical));
}
