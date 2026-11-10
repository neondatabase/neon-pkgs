import {
	Aes256Gcm,
	CipherSuite,
	DhkemP256HkdfSha256,
	HkdfSha256,
} from "@hpke/core";
import { encodeBase64Url, utf8 } from "./crypto.js";
import type { RealtimeQueryCapabilityV3 } from "./schema/realtime-query-capability-v3.gen.js";

export const ENVELOPE_ALG = "HPKE-P256-SHA256-A256GCM";
const ENVELOPE_INFO = utf8("neon-realtime/envelope/v3");
const MAX_ENVELOPE_BYTES = 256 * 1024;

export type EnvelopeHeader = RealtimeQueryCapabilityV3["protected"];
export type EnvelopeClaims = RealtimeQueryCapabilityV3["claims"];

/** The login the proxy checks, as sealed into `auth`. */
export interface EnvelopeLogin {
	readonly user: string;
	readonly credential: string;
}

/** A branch public key the SDK seals to. */
export interface EnvelopeKey {
	readonly kid: string;
	readonly publicKey: CryptoKey;
}

let suite: CipherSuite | undefined;

/** HPKE base mode, DHKEM(P-256, HKDF-SHA256), HKDF-SHA256, AES-256-GCM. */
export function envelopeSuite(): CipherSuite {
	suite ??= new CipherSuite({
		kem: new DhkemP256HkdfSha256(),
		kdf: new HkdfSha256(),
		aead: new Aes256Gcm(),
	});
	return suite;
}

/**
 * Seal claims to a branch key as a five-segment v3 envelope. The base64url
 * header text is the associated data, so the header cannot be changed.
 *
 * @param ephemeralKeyMaterial - Tests only: fixes the sender's ephemeral key.
 */
export async function sealEnvelope(
	key: EnvelopeKey,
	claims: EnvelopeClaims,
	ephemeralKeyMaterial?: Uint8Array,
): Promise<string> {
	const header: EnvelopeHeader = { alg: ENVELOPE_ALG, kid: key.kid, v: 3 };
	const encodedHeader = encodeBase64Url(utf8(JSON.stringify(header)));
	const { ct, enc } = await envelopeSuite().seal(
		{
			recipientPublicKey: key.publicKey,
			info: ENVELOPE_INFO,
			...(ephemeralKeyMaterial ? { ekm: ephemeralKeyMaterial } : {}),
		},
		utf8(JSON.stringify(claims)),
		utf8(encodedHeader),
	);
	const envelope = [
		encodedHeader,
		encodeBase64Url(new Uint8Array(enc)),
		"",
		encodeBase64Url(new Uint8Array(ct)),
		"",
	].join(".");
	if (utf8(envelope).length > MAX_ENVELOPE_BYTES) {
		throw new Error("Live-query capability exceeds the size limit");
	}
	return envelope;
}
