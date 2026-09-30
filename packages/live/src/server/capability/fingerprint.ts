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

/** Compute the stable identity used to reject renewal with a different query. */
export async function queryFingerprint(
	query: PreparedLiveQuery,
): Promise<string> {
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
	const digest = await webCrypto().subtle.digest(
		"SHA-256",
		asBufferSource(
			concatBytes(FINGERPRINT_DOMAIN, utf8(JSON.stringify(canonical))),
		),
	);
	return encodeHex(new Uint8Array(digest));
}
