import { describe, expect, test } from "vitest";
import { deploymentPollDelay } from "./functions.js";

describe("deploymentPollDelay", () => {
	test("checks soon, then backs off to two seconds", () => {
		expect(
			[0, 1, 2, 3, 4, 10].map((attempt) =>
				deploymentPollDelay(attempt, undefined),
			),
		).toEqual([200, 400, 800, 1600, 2000, 2000]);
	});

	test("uses an override for every poll", () => {
		expect(deploymentPollDelay(0, 1)).toBe(1);
		expect(deploymentPollDelay(6, 5000)).toBe(5000);
	});
});
