import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";

import protocolSchema from "../../../../schema/neon-live-protocol-v1.schema.json";
import capabilitySchema from "../../../../schema/neon-live-query-capability-v1.schema.json";
import capabilityFixtures from "../../../server/capability/schema/neon-live-query-capability-v1.fixtures.json";
import protocolFixtures from "./neon-live-protocol-v1.fixtures.json";

describe("Realtime protocol contracts", () => {
	it("accepts every public protocol fixture marked valid", () => {
		const validate = validator(protocolSchema);
		for (const fixture of protocolFixtures.valid) {
			expect(validate(fixture), JSON.stringify(validate.errors)).toBe(
				true,
			);
		}
	});

	it("rejects every public protocol fixture marked invalid", () => {
		const validate = validator(protocolSchema);
		for (const fixture of protocolFixtures.invalid) {
			expect(validate(fixture), JSON.stringify(fixture)).toBe(false);
		}
	});

	it("accepts only the agreed decoded query capability shape", () => {
		const validate = validator(capabilitySchema);
		for (const fixture of capabilityFixtures.valid) {
			expect(validate(fixture), JSON.stringify(validate.errors)).toBe(
				true,
			);
		}
		for (const fixture of capabilityFixtures.invalid) {
			expect(validate(fixture), JSON.stringify(fixture)).toBe(false);
		}
	});
});

function validator(schema: object) {
	const ajv = new Ajv2020({
		discriminator: true,
		strict: true,
		validateFormats: false,
	});
	for (const keyword of [
		"x-maximum",
		"x-jweCompact",
		"x-maxUtf8Bytes",
		"x-decodedMaxBytes",
		"x-invariants",
	]) {
		ajv.addKeyword(keyword);
	}
	return ajv.compile(schema);
}
