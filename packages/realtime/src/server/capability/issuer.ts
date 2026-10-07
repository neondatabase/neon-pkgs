import type { PreparedLiveQuery } from "../adapter.js";
import {
	asBufferSource,
	encodeBase64,
	encodeBase64Url,
	utf8,
	webCrypto,
} from "./crypto.js";
import { queryFingerprint } from "./fingerprint.js";
import type { RealtimeQueryCapabilityV1 } from "./schema/realtime-query-capability-v1.gen.js";
import type { RealtimeSecret } from "./secret.js";

const SEALED_QUERY_LIFETIME_SECONDS = 60;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const MAX_TOKEN_BYTES = 256 * 1024;

export interface IssuedSealedLiveQuery {
	readonly capability: string;
	readonly queryFingerprint: string;
	/** Capability expiry as Unix milliseconds. */
	readonly expiresAt: number;
}

type ProtectedHeader = RealtimeQueryCapabilityV1["protected"];
type CapabilityClaims = RealtimeQueryCapabilityV1["claims"];

/** Create a local Compact-JWE issuer backed by an opaque Realtime secret. */
export function createCapabilityIssuer(
	secret: RealtimeSecret,
	database: string,
	errorDetails: CapabilityClaims["error_details"] = "safe",
	clock: () => number = Date.now,
): (query: PreparedLiveQuery) => Promise<IssuedSealedLiveQuery> {
	const keyPromise = importAesKey(secret.key);
	return async (query) => {
		const queryFingerprintValue = await queryFingerprint(query);
		const issuedAt = Math.floor(clock() / 1_000);
		const expiresAt = issuedAt + SEALED_QUERY_LIFETIME_SECONDS;
		const claims: CapabilityClaims = {
			v: 1,
			aud: "realtime-proxy",
			database,
			error_details: errorDetails,
			query_fingerprint: queryFingerprintValue,
			sql: query.sql,
			parameters: query.parameters.map((parameter) => ({
				type_oid: parameter.typeOid,
				value:
					parameter.value === null
						? null
						: encodeBase64(utf8(parameter.value)),
			})),
			iat: issuedAt,
			exp: expiresAt,
		};
		const protectedHeader: ProtectedHeader = {
			alg: "dir",
			enc: "A256GCM",
			v: 1,
		};
		const capability = await encryptCompactJwe(
			await keyPromise,
			protectedHeader,
			claims,
		);
		return Object.freeze({
			capability,
			queryFingerprint: queryFingerprintValue,
			expiresAt: expiresAt * 1_000,
		});
	};
}

async function encryptCompactJwe(
	key: CryptoKey,
	header: ProtectedHeader,
	claims: CapabilityClaims,
): Promise<string> {
	const encodedHeader = encodeBase64Url(utf8(JSON.stringify(header)));
	const iv = webCrypto().getRandomValues(new Uint8Array(IV_BYTES));
	const encrypted = new Uint8Array(
		await webCrypto().subtle.encrypt(
			{
				name: "AES-GCM",
				iv: asBufferSource(iv),
				additionalData: asBufferSource(utf8(encodedHeader)),
				tagLength: TAG_BYTES * 8,
			},
			key,
			asBufferSource(utf8(JSON.stringify(claims))),
		),
	);
	const ciphertext = encrypted.subarray(0, encrypted.length - TAG_BYTES);
	const tag = encrypted.subarray(encrypted.length - TAG_BYTES);
	const token = [
		encodedHeader,
		"",
		encodeBase64Url(iv),
		encodeBase64Url(ciphertext),
		encodeBase64Url(tag),
	].join(".");
	if (utf8(token).length > MAX_TOKEN_BYTES) {
		throw new Error("Live-query capability exceeds the size limit");
	}
	return token;
}

async function importAesKey(key: Uint8Array): Promise<CryptoKey> {
	return webCrypto().subtle.importKey(
		"raw",
		asBufferSource(key),
		{ name: "AES-GCM" },
		false,
		["encrypt"],
	);
}
