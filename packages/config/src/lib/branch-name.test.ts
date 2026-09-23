import { describe, expect, test } from "vitest";
import { neonSafeBranchName } from "./branch-name.js";

describe("neonSafeBranchName", () => {
	test("lowercases and slugifies a simple name", () => {
		expect(neonSafeBranchName("Feature")).toBe("feature");
	});

	test("preserves slashes as segment separators by default", () => {
		expect(neonSafeBranchName("feature/billing-ui")).toBe(
			"feature/billing-ui",
		);
	});

	test("sanitizes each segment and collapses separator runs", () => {
		expect(neonSafeBranchName("feature/PROJ-123 Add  Billing!!")).toBe(
			"feature/proj-123-add-billing",
		);
	});

	test("trims leading/trailing separators per segment", () => {
		expect(neonSafeBranchName("--feature--/__billing__")).toBe(
			"feature/billing",
		);
	});

	test("drops empty segments from repeated slashes", () => {
		expect(neonSafeBranchName("feature///billing")).toBe("feature/billing");
	});

	test("applies a prefix", () => {
		expect(neonSafeBranchName("feature/x", { prefix: "preview/" })).toBe(
			"preview/feature/x",
		);
	});

	test("flattens slashes when preserveSlashes is false", () => {
		expect(
			neonSafeBranchName("feature/billing", { preserveSlashes: false }),
		).toBe("feature-billing");
	});

	test("keeps original case when lowercase is false", () => {
		expect(
			neonSafeBranchName("Feature/Billing", { lowercase: false }),
		).toBe("Feature/Billing");
	});

	test("falls back to 'branch' for an empty/punctuation-only input", () => {
		expect(neonSafeBranchName("")).toBe("branch");
		expect(neonSafeBranchName("///")).toBe("branch");
		expect(neonSafeBranchName("!!!")).toBe("branch");
	});

	test("clamps to maxLength and strips a dangling separator", () => {
		const result = neonSafeBranchName(`${"a".repeat(20)}-bbbbb`, {
			maxLength: 20,
		});
		expect(result.length).toBeLessThanOrEqual(20);
		expect(result.endsWith("-")).toBe(false);
		expect(result.endsWith("/")).toBe(false);
	});

	test("never returns an empty string even after clamping", () => {
		expect(neonSafeBranchName("----------", { maxLength: 1 })).toBe(
			"branch",
		);
	});

	test("is idempotent on an already-valid name", () => {
		const once = neonSafeBranchName("preview/feature/billing-ui");
		expect(neonSafeBranchName(once)).toBe(once);
	});

	test("flattens to a single token when preserveSlashes is false", () => {
		expect(
			neonSafeBranchName("feature/Billing UI", {
				preserveSlashes: false,
			}),
		).toBe("feature-billing-ui");
	});
});
