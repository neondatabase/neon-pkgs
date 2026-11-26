import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";
import {
	type EnvelopeClaims,
	envelopeSuite,
	sealEnvelope,
} from "./envelope.js";
import {
	ENVELOPE_INFO,
	type FixtureKey,
	fromBase64Url,
	openEnvelope,
	toBase64Url,
} from "./envelope.test-helpers.js";
import { createEnvelopeIssuer } from "./issuer.js";
import { importRealtimePublicKey } from "./keys.js";

// RFC 9180 test vector for mode_base, DHKEM(P-256, HKDF-SHA256), HKDF-SHA256,
// AES-256-GCM: the one entry with mode 0, kem_id 16, kdf_id 1, aead_id 2 in
// test-vectors.json of cfrg/draft-irtf-cfrg-hpke at
// 5f503c564da00b0687b3de75f1dfbdfc4079ad31. Only sequence number 0 applies,
// since envelopes are single-shot.
const RFC9180 = {
	info: "4f6465206f6e2061204772656369616e2055726e",
	ikmR: "a0ce15d49e28bd47a18a97e147582d814b08cbe00109fed5ec27d1b4e9f6f5e3",
	ikmE: "a90d3417c3da9cb6c6ae19b4b5dd6cc9529a4cc24efb7ae0ace1f31887a8cd6c",
	skRm: "317f915db7bc629c48fe765587897e01e282d3e8445f79f27f65d031a88082b2",
	skEm: "90345e3a1d116c1dd39ae76d95ab858c142223a63e44f8f85318cfa91a84858e",
	pkRm: "04abc7e49a4c6b3566d77d0304addc6ed0e98512ffccf505e6a8e3eb25c685136f853148544876de76c0f2ef99cdc3a05ccf5ded7860c7c021238f9e2073d2356c",
	pkEm: "04c06b4f6bebc7bb495cb797ab753f911aff80aefb86fd8b6fcc35525f3ab5f03e0b21bd31a86c6048af3cb2d98e0d3bf01da5cc4c39ff5370d331a4f1f7d5a4e0",
	enc: "04c06b4f6bebc7bb495cb797ab753f911aff80aefb86fd8b6fcc35525f3ab5f03e0b21bd31a86c6048af3cb2d98e0d3bf01da5cc4c39ff5370d331a4f1f7d5a4e0",
	encryption: {
		aad: "436f756e742d30",
		pt: "4265617574792069732074727574682c20747275746820626561757479",
		ct: "58c61a45059d0c5704560e9d88b564a8b63f1364b8d1fcb3c4c6ddc1d291742465e902cd216f8908da49f8f96f",
	},
} as const;

const hex = (value: string) => new Uint8Array(Buffer.from(value, "hex"));
const toHex = (value: ArrayBuffer | Uint8Array) =>
	Buffer.from(
		value instanceof Uint8Array ? value : new Uint8Array(value),
	).toString("hex");

interface Fixtures {
	readonly now: number;
	readonly keys: readonly FixtureKey[];
	readonly valid: readonly {
		readonly name: string;
		readonly envelope: string;
		readonly claims: EnvelopeClaims;
	}[];
}

const fixtures = JSON.parse(
	readFileSync(
		new URL(
			"../../../schema/realtime-envelope-v3.fixtures.json",
			import.meta.url,
		),
		"utf8",
	),
) as Fixtures;
const primary = fixtures.keys[0] as FixtureKey;

/** The generator's ephemeral key input for a fixture name. */
function fixtureEphemeral(name: string): Uint8Array {
	return new Uint8Array(
		createHash("sha256")
			.update(`neon-realtime/envelope/v3/fixtures/ephemeral/${name}`)
			.digest(),
	);
}

function fixtureByName(name: string) {
	const fixture = fixtures.valid.find((entry) => entry.name === name);
	if (!fixture) throw new Error(`missing fixture ${name}`);
	return fixture;
}

describe("HPKE suite", () => {
	const suite = envelopeSuite();

	it("derives the RFC 9180 recipient and ephemeral key pairs", async () => {
		const recipient = await suite.kem.deriveKeyPair(hex(RFC9180.ikmR));
		const ephemeral = await suite.kem.deriveKeyPair(hex(RFC9180.ikmE));
		expect(
			toHex(await suite.kem.serializePrivateKey(recipient.privateKey)),
		).toBe(RFC9180.skRm);
		expect(
			toHex(await suite.kem.serializePublicKey(recipient.publicKey)),
		).toBe(RFC9180.pkRm);
		expect(
			toHex(await suite.kem.serializePrivateKey(ephemeral.privateKey)),
		).toBe(RFC9180.skEm);
		expect(
			toHex(await suite.kem.serializePublicKey(ephemeral.publicKey)),
		).toBe(RFC9180.pkEm);
	});

	it("seals the RFC 9180 plaintext to the vector's enc and ciphertext", async () => {
		const recipientPublicKey = await suite.kem.deserializePublicKey(
			hex(RFC9180.pkRm),
		);
		const { ct, enc } = await suite.seal(
			{
				recipientPublicKey,
				info: hex(RFC9180.info),
				ekm: hex(RFC9180.ikmE),
			},
			hex(RFC9180.encryption.pt),
			hex(RFC9180.encryption.aad),
		);
		expect(toHex(enc)).toBe(RFC9180.enc);
		expect(toHex(ct)).toBe(RFC9180.encryption.ct);
	});

	it("opens the RFC 9180 ciphertext with the recipient key", async () => {
		const recipientKey = await suite.kem.deserializePrivateKey(
			hex(RFC9180.skRm),
		);
		const plaintext = await suite.open(
			{ recipientKey, enc: hex(RFC9180.enc), info: hex(RFC9180.info) },
			hex(RFC9180.encryption.ct),
			hex(RFC9180.encryption.aad),
		);
		expect(toHex(plaintext)).toBe(RFC9180.encryption.pt);
	});

	it("rejects a public key that is not on the curve", async () => {
		const offCurve = hex(RFC9180.pkRm);
		offCurve[64] = (offCurve[64] ?? 0) ^ 0x01;
		await expect(
			suite.kem.deserializePublicKey(offCurve),
		).rejects.toThrow();
	});
});

describe("Realtime envelope v3 sealing", () => {
	it.each(
		fixtures.valid.map((fixture) => [fixture.name, fixture] as const),
	)("reproduces the %s fixture byte for byte", async (name, fixture) => {
		const key = await importRealtimePublicKey(primary);
		expect(
			await sealEnvelope(key, fixture.claims, fixtureEphemeral(name)),
		).toBe(fixture.envelope);
	});

	it("builds the same claims and envelope as the fixture generator", async () => {
		const fixture = fixtureByName("password");
		const key = await importRealtimePublicKey(primary);
		const issue = createEnvelopeIssuer({
			login: async () => ({
				user: "neondb_owner",
				credential: "fixture-password-correct-horse",
			}),
			database: "neondb",
			clock: () => fixtures.now * 1_000,
			ephemeralKeyMaterial: () => fixtureEphemeral("password"),
		});

		const sealed = await issue(
			{
				sql: "select id, body from messages where channel_id = $1",
				parameters: [{ typeOid: 23, value: "7" }],
			},
			"raw_sql",
			key,
		);

		expect(sealed).toEqual({
			capability: fixture.envelope,
			queryFingerprint: fixture.claims.query_fingerprint,
			expiresAt: fixture.claims.exp * 1_000,
		});
	});

	it("uses a fresh ephemeral key for every envelope", async () => {
		const key = await importRealtimePublicKey(primary);
		const claims = fixtureByName("password").claims;
		const first = (await sealEnvelope(key, claims)).split(".");
		const second = (await sealEnvelope(key, claims)).split(".");
		expect(first[0]).toBe(second[0]);
		expect(first[1]).not.toBe(second[1]);
		expect(first[3]).not.toBe(second[3]);
	});

	it("serializes the exact header and five-segment layout", async () => {
		const key = await importRealtimePublicKey(primary);
		const envelope = await sealEnvelope(
			key,
			fixtureByName("password").claims,
		);
		const [header, enc, empty3, ciphertext, empty5, extra] =
			envelope.split(".");
		expect(Buffer.from(header ?? "", "base64url").toString()).toBe(
			`{"alg":"HPKE-P256-SHA256-A256GCM","kid":"${primary.kid}","v":3}`,
		);
		expect(fromBase64Url(enc ?? "")).toHaveLength(65);
		expect(fromBase64Url(enc ?? "")[0]).toBe(0x04);
		expect(empty3).toBe("");
		expect(fromBase64Url(ciphertext ?? "").length).toBeGreaterThanOrEqual(
			17,
		);
		expect(empty5).toBe("");
		expect(extra).toBeUndefined();
		for (const segment of [header, enc, ciphertext]) {
			expect(segment).toMatch(/^[A-Za-z0-9_-]+$/);
		}
		const opened = await openEnvelope(envelope, primary);
		expect(JSON.parse(opened.plaintext)).toEqual(
			fixtureByName("password").claims,
		);
	});

	it("binds the header: the envelope does not open under another header", async () => {
		const key = await importRealtimePublicKey(primary);
		const envelope = await sealEnvelope(
			key,
			fixtureByName("password").claims,
		);
		const segments = envelope.split(".");
		segments[0] = toBase64Url(
			new TextEncoder().encode(
				`{"alg":"HPKE-P256-SHA256-A256GCM","kid":"${primary.kid}","v":3} `,
			),
		);
		await expect(
			openEnvelope(segments.join("."), primary),
		).rejects.toThrow();
		expect(ENVELOPE_INFO).toBe("neon-realtime/envelope/v3");
	});

	it("refuses envelopes over the 256 KiB cap", async () => {
		const key = await importRealtimePublicKey(primary);
		const claims = {
			...fixtureByName("password").claims,
			sql: "x".repeat(200_000),
		};
		await expect(sealEnvelope(key, claims)).rejects.toThrow(
			"Live-query capability exceeds the size limit",
		);
	});
});
