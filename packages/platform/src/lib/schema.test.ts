import { describe, expect, test } from "vitest";
import {
	branchBlueprintSchema,
	branchConfigSchema,
	computeSettingsSchema,
	configSchema,
	formatZodIssues,
	projectConfigSchema,
} from "./schema.js";

describe("schema — basic shape", () => {
	test("configSchema accepts a minimal config", () => {
		expect(configSchema.safeParse({ project: { name: "x" } }).success).toBe(
			true,
		);
	});

	test("configSchema accepts the full example from PLAN.md", () => {
		const result = configSchema.safeParse({
			project: { name: "my-app", region: "aws-us-east-1" },
			branches: {
				production: {
					protected: true,
					computeSettings: { autoscalingLimitMaxCu: 2 },
				},
				staging: { parent: "production" },
			},
			branchBlueprints: {
				preview: {
					pattern: "preview-*",
					ttl: "1h",
					parent: "production",
				},
			},
		});
		expect(result.success).toBe(true);
	});

	test("schemas are independently usable", () => {
		expect(projectConfigSchema.safeParse({ name: "x" }).success).toBe(true);
		expect(branchConfigSchema.safeParse({ protected: true }).success).toBe(
			true,
		);
		expect(
			branchBlueprintSchema.safeParse({
				pattern: "preview-*",
				ttl: "1h",
			}).success,
		).toBe(true);
		expect(
			computeSettingsSchema.safeParse({ autoscalingLimitMaxCu: 1 })
				.success,
		).toBe(true);
	});
});

describe("schema — issue formatting", () => {
	test("renders nested paths as dot-separated property accesses", () => {
		const result = configSchema.safeParse({
			project: { name: "x" },
			branchBlueprints: {
				preview: { pattern: "preview-*", ttl: "abc" },
			},
		});
		expect(result.success).toBe(false);
		if (result.success) return;
		const issues = formatZodIssues(result.error);
		expect(
			issues.some((i) => i.startsWith("branchBlueprints.preview.ttl:")),
		).toBe(true);
	});

	test("aggregates every issue rather than failing fast on the first", () => {
		const result = configSchema.safeParse({
			project: { name: "", pgVersion: 99 },
			branchBlueprints: {
				preview: { pattern: "preview-*", ttl: "1mo" },
			},
		});
		expect(result.success).toBe(false);
		if (result.success) return;
		const issues = formatZodIssues(result.error);
		// project.name, project.pgVersion, branchBlueprints.preview.ttl
		expect(issues.length).toBeGreaterThanOrEqual(3);
	});

	test("normalises strictObject's unknown-key issue text", () => {
		const result = configSchema.safeParse({
			project: { name: "x", extra: true },
		});
		expect(result.success).toBe(false);
		if (result.success) return;
		const issues = formatZodIssues(result.error);
		expect(issues.some((i) => i.includes("unknown key"))).toBe(true);
		expect(issues.some((i) => i.includes('"extra"'))).toBe(true);
	});
});

describe("schema — branch / blueprint shape", () => {
	test("rejects a branches entry whose key is not a valid branch name", () => {
		const result = configSchema.safeParse({
			project: { name: "x" },
			branches: { "bad name!": {} },
		});
		expect(result.success).toBe(false);
		if (result.success) return;
		const issues = formatZodIssues(result.error);
		expect(issues.some((i) => i.includes("not a valid branch name"))).toBe(
			true,
		);
	});

	test("rejects a branches entry whose key is a wildcard", () => {
		const result = configSchema.safeParse({
			project: { name: "x" },
			branches: { "preview-*": {} },
		});
		expect(result.success).toBe(false);
		if (result.success) return;
		const issues = formatZodIssues(result.error);
		expect(issues.some((i) => i.includes("concrete branch name"))).toBe(
			true,
		);
	});

	test("requires a wildcard `pattern` on every branchBlueprints entry", () => {
		const noPattern = configSchema.safeParse({
			project: { name: "x" },
			branchBlueprints: { preview: {} },
		});
		expect(noPattern.success).toBe(false);

		const nonWildcard = configSchema.safeParse({
			project: { name: "x" },
			branchBlueprints: { preview: { pattern: "preview" } },
		});
		expect(nonWildcard.success).toBe(false);
		if (nonWildcard.success) return;
		const issues = formatZodIssues(nonWildcard.error);
		expect(issues.some((i) => i.includes("wildcard"))).toBe(true);
	});

	test("rejects collisions between branches and branchBlueprints keys", () => {
		const result = configSchema.safeParse({
			project: { name: "x" },
			branches: { preview: {} },
			branchBlueprints: { preview: { pattern: "preview-*" } },
		});
		expect(result.success).toBe(false);
		if (result.success) return;
		const issues = formatZodIssues(result.error);
		expect(issues.some((i) => i.includes("collides"))).toBe(true);
	});
});

describe("schema — computeSettings cross-field invariants", () => {
	test("min must be <= max", () => {
		const result = computeSettingsSchema.safeParse({
			autoscalingLimitMinCu: 4,
			autoscalingLimitMaxCu: 1,
		});
		expect(result.success).toBe(false);
		if (result.success) return;
		const issues = formatZodIssues(result.error);
		expect(issues[0]).toContain("<= autoscalingLimitMaxCu");
	});

	test("suspendTimeout outside [60..604800] but not 0 / -1 is rejected", () => {
		const result = computeSettingsSchema.safeParse({
			suspendTimeout: 30,
		});
		expect(result.success).toBe(false);
		if (result.success) return;
		const issues = formatZodIssues(result.error);
		expect(issues[0]).toContain("suspendTimeout");
	});
});

describe("schema — computeSettings runtime guards on untyped input", () => {
	// These cases are caught at compile time by the `ComputeUnit` literal type
	// (0.25 | 0.5 | 1 | 2 | 4 | 8), but `safeParse` takes `unknown`, so the
	// schema also defends against callers that get an untyped value from
	// somewhere TypeScript can't see (JSON.parse, plain JS, fetch responses).
	test.each<[string, unknown]>([
		[
			"autoscalingLimitMinCu below the smallest CU",
			{ autoscalingLimitMinCu: 0.1 },
		],
		[
			"autoscalingLimitMinCu not in the CU set",
			{ autoscalingLimitMinCu: 3 },
		],
		[
			"autoscalingLimitMaxCu not in the CU set",
			{ autoscalingLimitMaxCu: 16 },
		],
	])("rejects %s", (_label, untypedInput) => {
		const result = computeSettingsSchema.safeParse(untypedInput);
		expect(result.success).toBe(false);
		if (result.success) return;
		const issues = formatZodIssues(result.error);
		expect(issues.join("\n")).toMatch(/autoscalingLimit(Min|Max)Cu/);
	});
});
