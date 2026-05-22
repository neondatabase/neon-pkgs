import { describe, expect, test } from "vitest";
import {
	isWildcardPattern,
	matchPattern,
	validatePattern,
} from "./patterns.js";

describe("isWildcardPattern", () => {
	test.each([
		["production", false],
		["preview-*", true],
		["*", true],
		["pr-*-staging", true],
		["a.b", false],
		["a_b-c", false],
	])("isWildcardPattern(%s) === %s", (pattern, expected) => {
		expect(isWildcardPattern(pattern)).toBe(expected);
	});
});

describe("matchPattern", () => {
	test.each([
		["production", "production", true],
		["production", "production-2", false],
		["preview-*", "preview-pr-42", true],
		["preview-*", "preview-", true],
		["preview-*", "previewx", false],
		["preview-*", "staging", false],
		["*", "anything", true],
		["*-staging", "feat-staging", true],
		["*-staging", "staging", false],
		["a.b", "a.b", true],
		["a.b", "axb", false], // dot must be literal
	])("matchPattern(%s, %s) === %s", (pattern, name, expected) => {
		expect(matchPattern(pattern, name)).toBe(expected);
	});
});

describe("validatePattern", () => {
	test.each(["production", "preview-*", "a_b.c-*", "feat-123", "*"])(
		"accepts %s",
		(pattern) => {
			expect(validatePattern(pattern)).toEqual({ ok: true });
		},
	);

	test.each([
		["", "branch pattern is empty"],
		[" production", "leading or trailing whitespace"],
		["production ", "leading or trailing whitespace"],
		["sp ace", "unsupported characters"],
		["a".repeat(257), "exceeds 256 characters"],
		["bad{name}", "unsupported characters"],
	])("rejects %s", (pattern, expectedFragment) => {
		const result = validatePattern(pattern);
		expect(result).toHaveProperty("error");
		expect((result as { error: string }).error).toContain(expectedFragment);
	});

	test("accepts patterns with slashes (Neon branch names allow '/')", () => {
		expect(validatePattern("feature/foo")).toEqual({ ok: true });
		expect(validatePattern("feature/*")).toEqual({ ok: true });
	});
});
