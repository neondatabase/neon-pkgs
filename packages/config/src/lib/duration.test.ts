import { describe, expect, test } from "vitest";
import {
	formatDurationSeconds,
	MAX_BRANCH_TTL_SECONDS,
	parseBranchTtl,
	parseDuration,
} from "./duration.js";

describe("parseDuration", () => {
	test.each([
		["30s", 30],
		["5m", 300],
		["1h", 3600],
		["2h", 7200],
		["1d", 86_400],
		["7d", 604_800],
		["2w", 1_209_600],
		["1W", 604_800],
	])("parses %s as %d seconds", (input, expected) => {
		const result = parseDuration(input);
		expect(result).toEqual({ seconds: expected });
	});

	test("accepts integer numbers", () => {
		expect(parseDuration(60)).toEqual({ seconds: 60 });
	});

	test.each([
		["", "duration string is empty"],
		["   ", "duration string is empty"],
		["abc", 'invalid duration "abc"'],
		["1h30m", 'invalid duration "1h30m"'],
		// Bare numeric strings are rejected on purpose — pass a number for seconds, or add a unit.
		["7", "missing a unit"],
		["3600", "missing a unit"],
		["0", "missing a unit"],
		["0s", 'must be > 0, got "0s"'],
		["-5", 'invalid duration "-5"'],
	])("rejects %s", (input, expectedErrorFragment) => {
		const result = parseDuration(input);
		expect(result).toHaveProperty("error");
		expect((result as { error: string }).error).toContain(
			expectedErrorFragment,
		);
	});

	test("rejects non-integer numbers", () => {
		expect(parseDuration(1.5)).toEqual({
			error: expect.stringContaining("must be an integer"),
		});
	});

	test("rejects zero and negative numbers", () => {
		expect(parseDuration(0)).toEqual({
			error: expect.stringContaining("must be > 0"),
		});
		expect(parseDuration(-1)).toEqual({
			error: expect.stringContaining("must be > 0"),
		});
	});

	test("rejects non-finite numbers", () => {
		expect(parseDuration(Number.POSITIVE_INFINITY)).toEqual({
			error: expect.stringContaining("not a finite number"),
		});
		expect(parseDuration(Number.NaN)).toEqual({
			error: expect.stringContaining("not a finite number"),
		});
	});
});

describe("parseBranchTtl", () => {
	test("accepts durations within the 30-day cap", () => {
		expect(parseBranchTtl("7d")).toEqual({ seconds: 604_800 });
		expect(parseBranchTtl("30d")).toEqual({
			seconds: MAX_BRANCH_TTL_SECONDS,
		});
		expect(parseBranchTtl(3600)).toEqual({ seconds: 3600 });
	});

	test("rejects durations over 30 days", () => {
		const result = parseBranchTtl("31d");
		expect(result).toHaveProperty("error");
		expect((result as { error: string }).error).toContain(
			"at most 30 days",
		);
		expect(parseBranchTtl(MAX_BRANCH_TTL_SECONDS + 1)).toHaveProperty(
			"error",
		);
	});

	test("inherits parseDuration rules (unit required, > 0)", () => {
		expect(parseBranchTtl("7")).toHaveProperty("error");
		expect(parseBranchTtl(0)).toHaveProperty("error");
	});
});

describe("formatDurationSeconds", () => {
	test.each([
		[30, "30s"],
		[60, "1m"],
		[3600, "1h"],
		[86_400, "1d"],
		[604_800, "1w"],
		[1_209_600, "2w"],
		[7200, "2h"],
		[120, "2m"],
		[90, "90s"], // doesn't fit a clean minute boundary above 60 → falls back to seconds
	])("formats %d seconds as %s", (input, expected) => {
		expect(formatDurationSeconds(input)).toBe(expected);
	});

	test("throws on non-positive input", () => {
		expect(() => formatDurationSeconds(0)).toThrow(RangeError);
		expect(() => formatDurationSeconds(-1)).toThrow(RangeError);
	});

	test("round-trips parseDuration → formatDurationSeconds in canonical form", () => {
		// `7d` and `1w` both represent 604_800 seconds; the formatter chooses the largest
		// clean unit, so the canonical form is `1w`. This documents the chosen tie-break.
		const cases: Array<[string, string]> = [
			["30s", "30s"],
			["5m", "5m"],
			["1h", "1h"],
			["2h", "2h"],
			["1d", "1d"],
			["7d", "1w"],
			["1w", "1w"],
			["2w", "2w"],
		];
		for (const [input, canonical] of cases) {
			const parsed = parseDuration(input);
			if (!("seconds" in parsed))
				throw new Error(`failed to parse ${input}`);
			expect(formatDurationSeconds(parsed.seconds)).toBe(canonical);
		}
	});
});
