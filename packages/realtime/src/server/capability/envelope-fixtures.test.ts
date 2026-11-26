import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";
import {
	ENVELOPE_INFO,
	envelopeValidator,
	type FixtureKey,
	fromBase64Url,
	openEnvelope,
	publicPointOf,
	testSuite,
	toBase64Url,
} from "./envelope.test-helpers.js";
import { queryFingerprint } from "./fingerprint.js";

interface Fixtures {
	readonly description: string;
	readonly suite: Record<string, number>;
	readonly info: string;
	readonly now: number;
	readonly keys: readonly FixtureKey[];
	readonly valid: readonly {
		readonly name: string;
		readonly envelope: string;
		readonly claims: Record<string, unknown> & {
			readonly sql: string;
			readonly parameters: readonly {
				readonly type_oid?: number;
				readonly value: string | null;
			}[];
			readonly query_fingerprint: string;
			readonly iat: number;
			readonly exp: number;
		};
	}[];
	readonly invalid: readonly {
		readonly name: string;
		readonly envelope: string;
		readonly reason: string;
	}[];
}

const generator = fileURLToPath(
	new URL("../../../scripts/generate-envelope-fixtures.mjs", import.meta.url),
);
const fixtures = JSON.parse(
	readFileSync(
		new URL(
			"../../../schema/realtime-envelope-v3.fixtures.json",
			import.meta.url,
		),
		"utf8",
	),
) as Fixtures;
const validate = envelopeValidator();

// contracts.md section 1.6: every required case and its test class.
const REQUIRED_VALID = [
	"password",
	"oidc_jwt_shaped",
	"max_size_sql",
	"parameters_with_nulls",
];
const REQUIRED_INVALID: Record<string, string> = {
	changed_header: "decrypt_failed",
	changed_ciphertext: "decrypt_failed",
	changed_enc: "decrypt_failed",
	off_curve_enc: "invalid_enc",
	compressed_enc: "invalid_enc",
	short_enc: "invalid_enc",
	unknown_kid: "unknown_kid",
	dir_alg_v3: "unsupported_header",
	hpke_alg_v2: "unsupported_header",
	extra_header_key: "unsupported_header",
	duplicate_header_key: "unsupported_header",
	padded_segment: "malformed",
	non_canonical_base64url: "malformed",
	non_empty_segment_3: "malformed",
	non_empty_segment_5: "malformed",
	four_segments: "malformed",
	six_segments: "malformed",
	plaintext_not_json: "invalid_claims",
	duplicate_claim_key: "invalid_claims",
	missing_auth: "invalid_claims",
	extra_auth_key: "invalid_claims",
	empty_credential: "invalid_claims",
	wrong_aud: "invalid_claims",
	expired: "expired",
	not_yet_valid: "not_yet_valid",
	lifetime_too_long: "invalid_claims",
};
const REASONS = new Set([
	"malformed",
	"unsupported_header",
	"unknown_kid",
	"invalid_enc",
	"decrypt_failed",
	"invalid_claims",
	"expired",
	"not_yet_valid",
]);

const primaryKey = fixtures.keys[0] as FixtureKey;

function headerOf(envelope: string): Record<string, unknown> {
	return JSON.parse(
		Buffer.from(envelope.split(".")[0] ?? "", "base64url").toString("utf8"),
	);
}

function keyFor(envelope: string): FixtureKey | undefined {
	const { kid } = headerOf(envelope);
	return fixtures.keys.find((key) => key.kid === kid);
}

describe("Realtime envelope v3 fixtures", () => {
	it("are current with their generator", () => {
		expect(() =>
			execFileSync(process.execPath, [generator, "--check"]),
		).not.toThrow();
	});

	it("contain nothing that secret scanners flag", () => {
		// The proxy vendors this file, and Databricks' gitleaks rules reject
		// `npg_` passwords and `ey...`-prefixed JWTs, even fake ones.
		const npgToken = /\b(npg_[a-z0-9]{10,20})/i;
		const jwt =
			/\b(ey[a-zA-Z0-9]{17,}\.ey[a-zA-Z0-9/\\_-]{17,}\.(?:[a-zA-Z0-9/\\_-]{10,}={0,2})?)(?:['|"|\n|\r|\s|`|;]|$)/;
		for (const file of [
			"../../../schema/realtime-envelope-v3.fixtures.json",
			"../../../scripts/generate-envelope-fixtures.mjs",
		]) {
			const text = readFileSync(new URL(file, import.meta.url), "utf8");
			expect(text).not.toMatch(npgToken);
			expect(text).not.toMatch(jwt);
		}
	});

	it("record the contract's suite, info and clock", () => {
		expect(fixtures.description).toBe("Neon Realtime envelope v3 fixtures");
		expect(fixtures.suite).toEqual({
			mode: 0,
			kem_id: 16,
			kdf_id: 1,
			aead_id: 2,
		});
		expect(fixtures.info).toBe(ENVELOPE_INFO);
		expect(fixtures.now).toBe(1_767_225_600);
	});

	it("publish keys whose public points match their private scalars", () => {
		expect(fixtures.keys.length).toBeGreaterThanOrEqual(2);
		for (const key of fixtures.keys) {
			expect(key.kid).toMatch(/^[A-Za-z0-9_-]{21}[AQgw]$/);
			expect(fromBase64Url(key.sk)).toHaveLength(32);
			const point = publicPointOf(key.sk);
			expect(toBase64Url(point.subarray(1, 33))).toBe(key.x);
			expect(toBase64Url(point.subarray(33, 65))).toBe(key.y);
		}
		expect(new Set(fixtures.keys.map((key) => key.kid)).size).toBe(
			fixtures.keys.length,
		);
	});

	it("cover every required case once, with its test class", () => {
		const validNames = fixtures.valid.map((fixture) => fixture.name);
		const invalidNames = fixtures.invalid.map((fixture) => fixture.name);
		expect(new Set([...validNames, ...invalidNames]).size).toBe(
			validNames.length + invalidNames.length,
		);
		expect(validNames).toEqual(expect.arrayContaining(REQUIRED_VALID));
		const reasons = Object.fromEntries(
			fixtures.invalid.map((fixture) => [fixture.name, fixture.reason]),
		);
		expect(reasons).toMatchObject(REQUIRED_INVALID);
		for (const fixture of fixtures.invalid) {
			expect(REASONS).toContain(fixture.reason);
		}
	});

	it.each(
		fixtures.valid.map((fixture) => [fixture.name, fixture] as const),
	)("%s opens to its claims under the exact header", async (_, fixture) => {
		const segments = fixture.envelope.split(".");
		expect(segments).toHaveLength(5);
		expect(segments[2]).toBe("");
		expect(segments[4]).toBe("");
		expect(fromBase64Url(segments[1] ?? "")).toHaveLength(65);
		expect(new TextEncoder().encode(fixture.envelope).length).toBeLessThan(
			262_144,
		);

		const { header, plaintext } = await openEnvelope(
			fixture.envelope,
			primaryKey,
		);
		expect(header).toBe(
			`{"alg":"HPKE-P256-SHA256-A256GCM","kid":"${primaryKey.kid}","v":3}`,
		);
		expect(plaintext).toBe(JSON.stringify(fixture.claims));
		expect(
			validate({ protected: JSON.parse(header), claims: fixture.claims }),
			JSON.stringify(validate.errors),
		).toBe(true);
		const { claims } = fixture;
		expect(claims.iat).toBeLessThanOrEqual(fixtures.now + 30);
		expect(claims.exp).toBeGreaterThan(fixtures.now);
		expect(claims.exp - claims.iat).toBeGreaterThan(0);
		expect(claims.exp - claims.iat).toBeLessThanOrEqual(300);
		expect(
			await queryFingerprint({
				sql: claims.sql,
				parameters: claims.parameters.map((parameter) => ({
					typeOid: parameter.type_oid as number,
					value:
						parameter.value === null
							? null
							: Buffer.from(parameter.value, "base64").toString(
									"utf8",
								),
				})),
			}),
		).toBe(claims.query_fingerprint);
	});

	it("include a maximum-size SQL and a JWT-shaped OIDC credential", () => {
		const byName = Object.fromEntries(
			fixtures.valid.map((fixture) => [fixture.name, fixture.claims]),
		);
		expect(
			new TextEncoder().encode(byName.max_size_sql?.sql as string).length,
		).toBe(131_072);
		const credential = (
			byName.oidc_jwt_shaped?.auth as { credential: string }
		).credential;
		const segments = credential.split(".");
		expect(segments).toHaveLength(3);
		for (const segment of segments) {
			expect(segment).toMatch(/^[A-Za-z0-9_-]{40,}$/);
			// Secret scanners treat `ey...` segments as real JWTs.
			expect(segment.startsWith("ey")).toBe(false);
		}
		expect(
			byName.parameters_with_nulls?.parameters.filter(
				(parameter) => parameter.value === null,
			).length,
		).toBeGreaterThanOrEqual(2);
	});

	describe("invalid fixtures fail for their stated reason", () => {
		const byReason = (reason: string) =>
			fixtures.invalid
				.filter((fixture) => fixture.reason === reason)
				.map((fixture) => [fixture.name, fixture] as const);

		it.each(
			byReason("decrypt_failed"),
		)("%s parses but no key opens it", async (_, fixture) => {
			expect(fixture.envelope.split(".")).toHaveLength(5);
			expect(keyFor(fixture.envelope)).toBeDefined();
			for (const key of fixtures.keys) {
				await expect(
					openEnvelope(fixture.envelope, key),
				).rejects.toThrow();
			}
		});

		it.each(
			byReason("invalid_enc"),
		)("%s carries an enc that is not an uncompressed P-256 point", async (_, fixture) => {
			const enc = fromBase64Url(fixture.envelope.split(".")[1] ?? "");
			if (enc.length === 65 && enc[0] === 0x04) {
				await expect(
					testSuite.kem.deserializePublicKey(enc),
				).rejects.toThrow();
			}
		});

		it.each(
			byReason("unknown_kid"),
		)("%s names a key the fixtures do not hold", (_, fixture) => {
			expect(headerOf(fixture.envelope).alg).toBe(
				"HPKE-P256-SHA256-A256GCM",
			);
			expect(keyFor(fixture.envelope)).toBeUndefined();
		});

		it.each([
			...byReason("invalid_claims"),
			...byReason("expired"),
			...byReason("not_yet_valid"),
		])("%s opens, but its claims break the contract", async (_, fixture) => {
			const { header, plaintext } = await openEnvelope(
				fixture.envelope,
				primaryKey,
			);
			let claims: { iat: number; exp: number } | undefined;
			try {
				claims = JSON.parse(plaintext);
			} catch {
				return;
			}
			const duplicate = /"(\w+)":[^,]*,"\1":/.test(plaintext);
			const valid = validate({ protected: JSON.parse(header), claims });
			const live =
				claims !== undefined &&
				claims.exp - claims.iat > 0 &&
				claims.exp - claims.iat <= 300 &&
				claims.iat <= fixtures.now + 30 &&
				fixtures.now < claims.exp;
			expect(duplicate || !valid || !live).toBe(true);
		});
	});
});
