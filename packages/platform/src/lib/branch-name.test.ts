import { describe, expect, test } from "vitest";
import {
	buildBranchName,
	generateMiniId,
	normalizeGitBranch,
} from "./branch-name.js";

describe("normalizeGitBranch", () => {
	test.each([
		["andrelandgraf/new-feature", "andrelandgraf-new-feature"],
		["main", "main"],
		["Feat/Foo Bar", "feat-foo-bar"],
		["release/v1.2.3", "release-v1.2.3"],
		["UPPER_case", "upper_case"],
		["with--dashes//slashes", "with-dashes-slashes"],
		["  spaced  ", "spaced"],
		["weird!chars@here", "weird-chars-here"],
		["-leading-and-trailing-", "leading-and-trailing"],
		[".dot.start.", "dot.start"],
	])("normalizeGitBranch(%s) === %s", (input, expected) => {
		expect(normalizeGitBranch(input)).toBe(expected);
	});

	test.each(["", "---", "!!!!", "..."])(
		"normalizeGitBranch(%s) returns null",
		(input) => {
			expect(normalizeGitBranch(input)).toBeNull();
		},
	);
});

describe("generateMiniId", () => {
	test("returns 6 lowercase hex chars", () => {
		const id = generateMiniId();
		expect(id).toMatch(/^[0-9a-f]{6}$/);
	});

	test("returns different values across many calls", () => {
		const ids = new Set<string>();
		for (let i = 0; i < 1000; i++) ids.add(generateMiniId());
		// With 24 bits of entropy, 1000 samples should have well under 1% collision
		// probability — assert no more than a single duplicate to keep the test stable.
		expect(ids.size).toBeGreaterThan(998);
	});
});

describe("buildBranchName", () => {
	test("inserts the mini-id when no git branch is provided", () => {
		expect(
			buildBranchName({ pattern: "preview-*", miniId: "abc123" }),
		).toBe("preview-abc123");
	});

	test("inserts <gitBranch>-<miniId> when both are provided", () => {
		expect(
			buildBranchName({
				pattern: "preview-*",
				gitBranch: "andre-feature",
				miniId: "abc123",
			}),
		).toBe("preview-andre-feature-abc123");
	});

	test("handles multiple wildcards by substituting each", () => {
		expect(
			buildBranchName({
				pattern: "feat-*-prod-*",
				miniId: "abc123",
			}),
		).toBe("feat-abc123-prod-abc123");
	});

	test("trims an over-long git fragment to stay within the 256-char limit", () => {
		const longish = "feature-".repeat(40); // ~320 chars
		const name = buildBranchName({
			pattern: "preview-*",
			gitBranch: longish,
			miniId: "abc123",
		});
		expect(name.length).toBeLessThanOrEqual(256);
		expect(name.startsWith("preview-feature")).toBe(true);
		expect(name.endsWith("-abc123")).toBe(true);
	});

	test("falls back to bare-miniId form when removing the git fragment is not enough", () => {
		// Pathological pattern: the fixed text alone is over 250 chars, so even after
		// stripping the full git fragment, we still have to settle for the bare-miniId
		// fallback. Real users never hit this branch but the safety net is exercised here.
		const heavy = `${"x".repeat(250)}-*`;
		const name = buildBranchName({
			pattern: heavy,
			gitBranch: "andre-feature",
			miniId: "abc123",
		});
		expect(name).toBe(`${heavy.replace("*", "abc123")}`);
	});

	test("appends with a dash when the pattern has no wildcard", () => {
		expect(
			buildBranchName({ pattern: "production", miniId: "abc123" }),
		).toBe("production-abc123");
	});
});
