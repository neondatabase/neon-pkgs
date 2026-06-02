import { describe, expect, test } from "vitest";
import { ConfigValidationError, PushConflictError } from "./errors.js";

describe("ConfigValidationError", () => {
	test("formats issues", () => {
		const err = new ConfigValidationError(["ttl: invalid duration"]);
		expect(err.message).toContain("ttl: invalid duration");
	});
});

describe("PushConflictError", () => {
	test("formats branch conflicts with updateExisting hint", () => {
		const err = new PushConflictError([
			{
				kind: "branch",
				identifier: "main",
				field: "protected",
				current: false,
				desired: true,
				reason: "different protected flag",
			},
		]);
		expect(err.message).toContain("[branch:main] protected");
		expect(err.message).toContain("--update-existing");
	});
});
