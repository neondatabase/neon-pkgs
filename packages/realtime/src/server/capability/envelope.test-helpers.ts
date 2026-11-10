import { createECDH } from "node:crypto";

import {
	Aes256Gcm,
	CipherSuite,
	DhkemP256HkdfSha256,
	HkdfSha256,
} from "@hpke/core";
import Ajv2020 from "ajv/dist/2020.js";
import envelopeSchema from "../../../schema/realtime-query-capability-v3.schema.json";

export const ENVELOPE_INFO = "neon-realtime/envelope/v3";

export interface FixtureKey {
	readonly kid: string;
	readonly sk: string;
	readonly x: string;
	readonly y: string;
}

export const testSuite = new CipherSuite({
	kem: new DhkemP256HkdfSha256(),
	kdf: new HkdfSha256(),
	aead: new Aes256Gcm(),
});

export function fromBase64Url(value: string): Uint8Array {
	return new Uint8Array(Buffer.from(value, "base64url"));
}

export function toBase64Url(value: Uint8Array): string {
	return Buffer.from(value).toString("base64url");
}

/** Public point of a fixture key, derived from its private scalar. */
export function publicPointOf(sk: string): Uint8Array {
	const ecdh = createECDH("prime256v1");
	ecdh.setPrivateKey(fromBase64Url(sk));
	return new Uint8Array(ecdh.getPublicKey());
}

/** Open a v3 envelope with a fixture key; throws when HPKE open fails. */
export async function openEnvelope(
	envelope: string,
	key: Pick<FixtureKey, "sk">,
): Promise<{ readonly header: string; readonly plaintext: string }> {
	const [encodedHeader = "", encodedEnc = "", , encodedCiphertext = ""] =
		envelope.split(".");
	const recipientKey = await testSuite.kem.deserializePrivateKey(
		fromBase64Url(key.sk),
	);
	const plaintext = await testSuite.open(
		{
			recipientKey,
			enc: fromBase64Url(encodedEnc),
			info: new TextEncoder().encode(ENVELOPE_INFO),
		},
		fromBase64Url(encodedCiphertext),
		new TextEncoder().encode(encodedHeader),
	);
	return {
		header: Buffer.from(encodedHeader, "base64url").toString("utf8"),
		plaintext: new TextDecoder().decode(plaintext),
	};
}

/** Strict validator for the decoded `{protected, claims}` v3 contract. */
export function envelopeValidator() {
	const ajv = new Ajv2020({ strict: true, validateFormats: false });
	for (const keyword of [
		"x-hpkeCompact",
		"x-maxUtf8Bytes",
		"x-decodedMaxBytes",
		"x-invariants",
	]) {
		ajv.addKeyword(keyword);
	}
	return ajv.compile(envelopeSchema);
}
