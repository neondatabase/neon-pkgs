import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";

import protocolSchema from "../../../../schema/realtime-protocol.schema.json";
import capabilitySchema from "../../../../schema/realtime-query-capability.schema.json";
import capabilityFixtures from "../../../server/capability/schema/realtime-query-capability-v2.fixtures.json";
import orderedFixtures from "./ordered-changes.fixtures.json";
import protocolFixtures from "./realtime-protocol.fixtures.json";

describe("Realtime protocol contracts", () => {
	it("accepts every public protocol fixture marked valid", () => {
		const validate = validator(protocolSchema);
		for (const fixture of [
			...protocolFixtures.valid,
			...orderedFixtures.valid,
		]) {
			expect(validate(fixture), JSON.stringify(validate.errors)).toBe(
				true,
			);
		}
	});

	it("rejects every public protocol fixture marked invalid", () => {
		const validate = validator(protocolSchema);
		for (const fixture of [
			...protocolFixtures.invalid,
			...orderedFixtures.invalid,
		]) {
			expect(validate(fixture), JSON.stringify(fixture)).toBe(false);
		}
	});

	it("accepts bounded canonical future release lines", () => {
		const validateProtocol = validator(protocolSchema);
		const validateCapability = validator(capabilitySchema);
		const capability = capabilityFixtures.valid[0];

		for (const releaseLine of ["1", "42.7"]) {
			expect(
				validateProtocol({
					type: "client_info",
					sdk: "javascript",
					release_line: releaseLine,
				}),
				JSON.stringify(validateProtocol.errors),
			).toBe(true);
			expect(
				validateCapability({
					...capability,
					claims: {
						...capability.claims,
						issuer: {
							...capability.claims.issuer,
							release_line: releaseLine,
						},
					},
				}),
				JSON.stringify(validateCapability.errors),
			).toBe(true);
		}

		for (const releaseLine of [
			"00.3",
			"0.03",
			"0.3.0",
			"12345678901234567",
		]) {
			expect(
				validateProtocol({
					type: "client_info",
					sdk: "javascript",
					release_line: releaseLine,
				}),
				releaseLine,
			).toBe(false);
			expect(
				validateCapability({
					...capability,
					claims: {
						...capability.claims,
						issuer: {
							...capability.claims.issuer,
							release_line: releaseLine,
						},
					},
				}),
				releaseLine,
			).toBe(false);
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
