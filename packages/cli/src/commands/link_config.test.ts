import { describe, expect, test } from "vitest";

import { shouldOfferConfigInit } from "./link.js";

describe("shouldOfferConfigInit", () => {
	test("offers when there is no neon.ts and the offer is on", () => {
		expect(shouldOfferConfigInit({ hasConfig: false, offer: true })).toBe(
			true,
		);
	});

	test("skips when --no-config was passed", () => {
		expect(shouldOfferConfigInit({ hasConfig: false, offer: false })).toBe(
			false,
		);
	});

	test("skips when neon.ts already exists", () => {
		expect(shouldOfferConfigInit({ hasConfig: true, offer: true })).toBe(
			false,
		);
	});
});
