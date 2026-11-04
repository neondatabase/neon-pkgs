import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";

import legacySchema from "../../../../../schema/legacy/realtime-protocol-v1.schema.json";
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

	it("preserves the content-only v1 contract and rejects moves", () => {
		const validate = new Ajv2020({
			discriminator: true,
			strict: true,
			validateFormats: false,
		}).compile(legacySchema);
		for (const fixture of protocolFixtures.valid) {
			expect(validate(fixture), JSON.stringify(validate.errors)).toBe(
				true,
			);
		}
		for (const fixture of [
			...protocolFixtures.invalid,
			...orderedFixtures.valid,
		]) {
			expect(validate(fixture), JSON.stringify(fixture)).toBe(false);
		}
	});
});
