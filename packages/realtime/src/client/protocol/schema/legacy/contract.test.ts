import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";

import legacySchema from "../../../../../schema/legacy/realtime-protocol-v1.schema.json";
import legacyV2Schema from "../../../../../schema/legacy/realtime-protocol-v2.schema.json";
import legacyCapabilitySchema from "../../../../../schema/legacy/realtime-query-capability-v1.schema.json";
import orderedFixtures from "../ordered-changes.fixtures.json";
import rawProtocolFixtures from "../realtime-protocol.fixtures.json";
import segmentRoundFixtures from "../segment-rounds.fixtures.json";

type Fixture = Readonly<Record<string, unknown>>;

/**
 * A shared fixture as protocols before v3 send it: without the baseline
 * sync's round, scope and covered range, and without segment tags.
 */
function beforeV3(fixture: Fixture): Fixture {
	const {
		round: _round,
		scope: _scope,
		covered: _covered,
		...rest
	} = fixture;
	const untagged = (items: unknown) =>
		(items as readonly Fixture[]).map(
			({ segment_tag: _tag, ...item }) => item,
		);
	if (Array.isArray(rest.rows)) return { ...rest, rows: untagged(rest.rows) };
	if (Array.isArray(rest.changes))
		return { ...rest, changes: untagged(rest.changes) };
	return rest;
}

const protocolFixtures = {
	valid: (rawProtocolFixtures.valid as readonly Fixture[]).map(beforeV3),
	invalid: (rawProtocolFixtures.invalid as readonly Fixture[]).map(beforeV3),
};

describe("Legacy Realtime protocol compatibility", () => {
	it("keeps the exact v2 schema that proxies before v3 select", () => {
		const source = readFileSync(
			new URL(
				"../../../../../schema/legacy/realtime-protocol-v2.schema.json",
				import.meta.url,
			),
		);
		expect(createHash("sha256").update(source).digest("hex")).toBe(
			"0449246115ee8d7552343404a40635118269f6d12dae89f6897fdcec9d4be1b9",
		);
	});

	it("preserves the v2 contract without holes, rounds or segment tags", () => {
		const validate = new Ajv2020({
			discriminator: true,
			strict: true,
			validateFormats: false,
		}).compile(legacyV2Schema);
		for (const fixture of [
			...protocolFixtures.valid,
			...orderedFixtures.valid,
		]) {
			expect(validate(fixture), JSON.stringify(validate.errors)).toBe(
				true,
			);
		}
		for (const fixture of [
			...protocolFixtures.invalid,
			...orderedFixtures.invalid,
			...segmentRoundFixtures.valid,
		]) {
			expect(validate(fixture), JSON.stringify(fixture)).toBe(false);
		}
	});

	it("keeps the exact v1 schema pinned by the transition proxy", () => {
		const source = readFileSync(
			new URL(
				"../../../../../schema/legacy/realtime-protocol-v1.schema.json",
				import.meta.url,
			),
		);
		expect(createHash("sha256").update(source).digest("hex")).toBe(
			"93f3410858bd1cbefae1008dda76cd599a88e3d00ce9f883eeb4e37bf094bc48",
		);
	});

	it("keeps the exact v1 capability schema", () => {
		const source = readFileSync(
			new URL(
				"../../../../../schema/legacy/realtime-query-capability-v1.schema.json",
				import.meta.url,
			),
		);
		expect(createHash("sha256").update(source).digest("hex")).toBe(
			"d1caa8e51098cf14ef8cc544a2e7dbd13f5bd2af8d93d664dd7efcb5c3c26c51",
		);
	});

	it("preserves the content-only v1 contract and rejects moves", () => {
		const validate = new Ajv2020({
			discriminator: true,
			strict: true,
			validateFormats: false,
		}).compile(legacySchema);
		for (const fixture of protocolFixtures.valid.filter(
			({ type }) => type !== "client_info" && type !== "client_warning",
		)) {
			expect(validate(fixture), JSON.stringify(validate.errors)).toBe(
				true,
			);
		}
		for (const fixture of [
			{
				type: "client_info",
				metadata: '{"sdk":"javascript","release_line":"0.2"}',
			},
			...protocolFixtures.invalid,
			...orderedFixtures.valid,
		]) {
			expect(validate(fixture), JSON.stringify(fixture)).toBe(false);
		}
	});

	it("preserves capability v1 without issuer metadata", () => {
		const validate = new Ajv2020({
			strict: true,
			validateFormats: false,
		});
		for (const keyword of [
			"x-jweCompact",
			"x-maxUtf8Bytes",
			"x-decodedMaxBytes",
			"x-invariants",
		]) {
			validate.addKeyword(keyword);
		}
		const capability = validate.compile(legacyCapabilitySchema);
		expect(
			capability({
				protected: { alg: "dir", enc: "A256GCM", v: 1 },
				claims: {
					v: 1,
					aud: "realtime-proxy",
					database: "app",
					error_details: "safe",
					query_fingerprint: "a".repeat(64),
					sql: "select 1",
					parameters: [],
					iat: 1000,
					exp: 1060,
				},
			}),
		).toBe(true);
	});
});
