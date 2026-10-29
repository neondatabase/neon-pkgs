import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";

import legacySchema from "../../../../../schema/legacy/realtime-protocol-v1.schema.json";
import legacyCapabilitySchema from "../../../../../schema/legacy/realtime-query-capability-v1.schema.json";
import orderedFixtures from "../ordered-changes.fixtures.json";
import protocolFixtures from "../realtime-protocol.fixtures.json";

describe("Legacy Realtime protocol compatibility", () => {
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
			({ type }) => type !== "client_info",
		)) {
			expect(validate(fixture), JSON.stringify(validate.errors)).toBe(
				true,
			);
		}
		for (const fixture of [
			{ type: "client_info", sdk: "javascript", release_line: "0.2" },
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
