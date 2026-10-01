import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import capabilitySchema from "../../../schema/neon-live-query-capability-v1.schema.json";
import { defined } from "../../defined.test-helpers.js";
import type { PreparedLiveQuery } from "../adapter.js";
import {
	asBufferSource,
	concatBytes,
	encodeBase64Url,
	utf8,
} from "./crypto.js";
import { createCapabilityIssuer } from "./issuer.js";
import { parseNeonLiveSecret } from "./secret.js";

const KEY = Uint8Array.from({ length: 32 }, (_, index) => index);
const SECRET = encodeSecret({
	v: 1,
	kid: "current",
	iss: "example-app",
	key: encodeBase64Url(KEY),
});
const QUERY: PreparedLiveQuery = {
	sql: "select id, body from messages where channel_id = $1",
	parameters: [{ typeOid: 23, value: "7" }],
};
const validateCapability = capabilityValidator();

describe("Neon Live v1 capability issuer", () => {
	it("extracts key-selection metadata from one opaque secret", () => {
		const parsed = parseNeonLiveSecret(SECRET);
		expect(parsed).toEqual({
			key: KEY,
			keyId: "current",
			issuer: "example-app",
		});
	});

	it("emits interoperable dir/A256GCM Compact JWE claims", async () => {
		const sealedQuery = await createCapabilityIssuer(
			parseNeonLiveSecret(SECRET),
			"app",
			"full",
			() => 1_700_000_000_123,
		)(QUERY);

		const { header, claims } = await decrypt(sealedQuery.capability, KEY);
		expect(
			validateCapability({ protected: header, claims }),
			JSON.stringify(validateCapability.errors),
		).toBe(true);
		expect(header).toEqual({
			alg: "dir",
			enc: "A256GCM",
			kid: "current",
			v: 1,
		});
		expect(claims).toMatchObject({
			v: 1,
			aud: "neon-live-proxy",
			iss: "example-app",
			database: "app",
			error_details: "full",
			query_fingerprint: sealedQuery.queryFingerprint,
			sql: QUERY.sql,
			parameters: [{ type_oid: 23, value: "Nw==" }],
			iat: 1_700_000_000,
			exp: 1_700_000_060,
		});
		expect(claims).not.toHaveProperty("branch");
		expect(sealedQuery.expiresAt).toBe(1_700_000_060_000);
	});

	it("defaults to safe error details", async () => {
		const sealedQuery = await createCapabilityIssuer(
			parseNeonLiveSecret(SECRET),
			"app",
		)(QUERY);

		const { claims } = await decrypt(sealedQuery.capability, KEY);
		expect(claims).toMatchObject({ error_details: "safe" });
	});

	it("uses a fresh 96-bit IV without changing the query fingerprint", async () => {
		const issue = createCapabilityIssuer(
			parseNeonLiveSecret(SECRET),
			"app",
		);
		const first = await issue(QUERY);
		const second = await issue(QUERY);
		expect(first.capability.split(".")[2]).not.toBe(
			second.capability.split(".")[2],
		);
		expect(first.queryFingerprint).toBe(second.queryFingerprint);
	});

	it("includes parameter OID hints in the query fingerprint", async () => {
		const issue = createCapabilityIssuer(
			parseNeonLiveSecret(SECRET),
			"app",
		);
		const int4 = await issue(QUERY);
		const int8 = await issue({
			...QUERY,
			parameters: [{ typeOid: 20, value: "7" }],
		});

		expect(int4.queryFingerprint).not.toBe(int8.queryFingerprint);
	});

	it("keeps generated capability types synchronized with the schema", () => {
		const generator = fileURLToPath(
			new URL(
				"../../../scripts/generate-capability-types.mjs",
				import.meta.url,
			),
		);
		expect(() =>
			execFileSync(process.execPath, [generator, "--check"]),
		).not.toThrow();
	});

	it.each([
		"",
		"old-raw-key",
		encodeSecret({
			v: 1,
			kid: "bad.kid",
			iss: "app",
			key: encodeBase64Url(KEY),
		}),
	])("rejects malformed opaque secrets", (secret) =>
		expect(() => parseNeonLiveSecret(secret)).toThrow(
			"Invalid Neon Live secret",
		));
});

async function decrypt(token: string, rawKey: Uint8Array) {
	const [
		encodedHeader,
		encryptedKey,
		encodedIv,
		encodedCiphertext,
		encodedTag,
	] = token.split(".");
	expect(encryptedKey).toBe("");
	const header = defined(encodedHeader);
	const iv = defined(encodedIv);
	const ciphertext = defined(encodedCiphertext);
	const tag = defined(encodedTag);
	const key = await crypto.subtle.importKey(
		"raw",
		asBufferSource(rawKey),
		"AES-GCM",
		false,
		["decrypt"],
	);
	const plaintext = await crypto.subtle.decrypt(
		{
			name: "AES-GCM",
			iv: asBufferSource(base64UrlDecode(iv)),
			additionalData: asBufferSource(utf8(header)),
			tagLength: 128,
		},
		key,
		asBufferSource(
			concatBytes(base64UrlDecode(ciphertext), base64UrlDecode(tag)),
		),
	);
	return {
		header: JSON.parse(new TextDecoder().decode(base64UrlDecode(header))),
		claims: JSON.parse(new TextDecoder().decode(plaintext)),
	};
}

function encodeSecret(value: object): string {
	return `neon_live_v1_${encodeBase64Url(utf8(JSON.stringify(value)))}`;
}

function base64UrlDecode(value: string): Uint8Array {
	const standard = value.replace(/-/g, "+").replace(/_/g, "/");
	const binary = atob(standard + "=".repeat((4 - (standard.length % 4)) % 4));
	return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function capabilityValidator() {
	const ajv = new Ajv2020({ strict: true, validateFormats: false });
	for (const keyword of [
		"x-maximum",
		"x-jweCompact",
		"x-maxUtf8Bytes",
		"x-decodedMaxBytes",
		"x-invariants",
	]) {
		ajv.addKeyword(keyword);
	}
	return ajv.compile(capabilitySchema);
}
