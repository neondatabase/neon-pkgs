import { describe, expect, test } from "vitest";
import {
	defineConfig,
	normalizeRegion,
	resolveConfig,
} from "./define-config.js";
import { ConfigValidationError } from "./errors.js";

describe("defineConfig", () => {
	test("accepts a minimal project-only config", () => {
		const cfg = defineConfig({ project: { name: "my-app" } });
		expect(cfg.project.name).toBe("my-app");
		expect(cfg.branchBlueprints).toBeUndefined();
	});

	test("freezes returned objects", () => {
		const cfg = defineConfig({
			project: { name: "my-app", region: "aws-us-east-1" },
			branchBlueprints: {
				production: { computeSettings: { autoscalingLimitMaxCu: 1 } },
			},
		});
		expect(Object.isFrozen(cfg)).toBe(true);
		expect(Object.isFrozen(cfg.project)).toBe(true);
		expect(Object.isFrozen(cfg.branchBlueprints)).toBe(true);
		expect(Object.isFrozen(cfg.branchBlueprints?.production)).toBe(true);
	});

	test("aggregates multiple validation issues into one error", () => {
		expect(() =>
			defineConfig({
				project: { name: "  ", region: "BAD" } as never,
				branchBlueprints: {
					"foo bar": {} as never,
					preview: { ttl: "abc" } as never,
					selfref: { parent: "selfref" } as never,
				} as never,
			}),
		).toThrow(ConfigValidationError);
		try {
			defineConfig({
				project: { name: "" } as never,
				branchBlueprints: { "bad name!": {} } as never,
			});
		} catch (err) {
			const e = err as ConfigValidationError;
			expect(e.issues.length).toBeGreaterThanOrEqual(2);
			expect(e.issues.some((i) => i.includes("project.name"))).toBe(true);
		}
	});

	test("rejects extra keys at every level", () => {
		expect(() =>
			defineConfig({
				project: { name: "x", extra: true } as never,
			}),
		).toThrow(/unknown key/);
		expect(() =>
			defineConfig({
				project: { name: "x" },
				branchBlueprints: { production: { whatevs: 1 } as never },
			}),
		).toThrow(/unknown key/);
	});

	test("rejects parent referencing itself", () => {
		expect(() =>
			defineConfig({
				project: { name: "x" },
				branchBlueprints: {
					production: { parent: "production" },
				},
			}),
		).toThrow(/must not reference itself/);
	});

	test("rejects parent pointing at a wildcard pattern", () => {
		expect(() =>
			defineConfig({
				project: { name: "x" },
				branchBlueprints: {
					production: {},
					feature: { parent: "preview-*" },
				},
			}),
		).toThrow(/must be a concrete branch name/);
	});

	test("allows parent that matches another blueprint key", () => {
		const cfg = defineConfig({
			project: { name: "x" },
			branchBlueprints: {
				production: {},
				preview: { pattern: "preview-*", parent: "production" },
			},
		});
		expect(cfg.branchBlueprints?.preview.parent).toBe("production");
	});

	test("allows parent that is a literal branch name not in blueprints", () => {
		const cfg = defineConfig({
			project: { name: "x" },
			branchBlueprints: {
				feature: { parent: "main" },
			},
		});
		expect(cfg.branchBlueprints?.feature.parent).toBe("main");
	});

	test("rejects ttl with invalid units", () => {
		expect(() =>
			defineConfig({
				project: { name: "x" },
				branchBlueprints: { preview: { ttl: "1mo" } } as never,
			}),
		).toThrow(/ttl:/);
	});

	test("accepts ttl as positive integer (interpreted as seconds)", () => {
		const cfg = defineConfig({
			project: { name: "x" },
			branchBlueprints: { preview: { ttl: 3600 } },
		});
		expect(cfg.branchBlueprints?.preview.ttl).toBe(3600);
	});

	test("rejects pgVersion outside the 14..18 range", () => {
		expect(() =>
			defineConfig({ project: { name: "x", pgVersion: 13 } }),
		).toThrow(/pgVersion/);
		expect(() =>
			defineConfig({ project: { name: "x", pgVersion: 19 } }),
		).toThrow(/pgVersion/);
	});

	test("rejects compute settings violating cross-field invariants (min > max)", () => {
		// Non-ComputeUnit values (e.g. 0.1, 3) are caught at compile time by the
		// `ComputeUnit` literal type, then again at runtime by the schema — see
		// `schema.test.ts` for the runtime-only assertions on `unknown` input.
		expect(() =>
			defineConfig({
				project: { name: "x" },
				branchBlueprints: {
					production: {
						computeSettings: {
							autoscalingLimitMinCu: 4,
							autoscalingLimitMaxCu: 1,
						},
					},
				},
			}),
		).toThrow(/<= autoscalingLimitMaxCu/);
	});

	test("rejects suspendTimeout outside legal range", () => {
		expect(() =>
			defineConfig({
				project: { name: "x" },
				branchBlueprints: {
					production: {
						computeSettings: { suspendTimeout: "30s" },
					},
				},
			}),
		).toThrow(/suspend timeout must be between 60 and 604800 seconds/);

		expect(() =>
			defineConfig({
				project: { name: "x" },
				branchBlueprints: {
					production: {
						computeSettings: { suspendTimeout: 1_000_000 },
					},
				},
			}),
		).toThrow(/suspend timeout must be between 60 and 604800 seconds/);
	});

	test("accepts suspendTimeout=undefined (platform default) and false (never)", () => {
		expect(() =>
			defineConfig({
				project: { name: "x" },
				branchBlueprints: {
					production: {
						computeSettings: { suspendTimeout: undefined },
					},
				},
			}),
		).not.toThrow();
		expect(() =>
			defineConfig({
				project: { name: "x" },
				branchBlueprints: {
					production: {
						computeSettings: { suspendTimeout: false },
					},
				},
			}),
		).not.toThrow();
		expect(() =>
			defineConfig({
				project: { name: "x" },
				branchBlueprints: {
					production: {
						computeSettings: { suspendTimeout: "5m" },
					},
				},
			}),
		).not.toThrow();
	});
});

describe("resolveConfig", () => {
	test("copies blueprint key into pattern when missing", () => {
		const resolved = resolveConfig(
			defineConfig({
				project: { name: "x" },
				branchBlueprints: {
					production: {},
					preview: { pattern: "preview-*" },
				},
			}),
		);
		const byKey = new Map(resolved.branchBlueprints.map((b) => [b.key, b]));
		expect(byKey.get("production")?.pattern).toBe("production");
		expect(byKey.get("preview")?.pattern).toBe("preview-*");
	});

	test("parses ttl into seconds", () => {
		const resolved = resolveConfig(
			defineConfig({
				project: { name: "x" },
				branchBlueprints: {
					preview: { pattern: "preview-*", ttl: "1h" },
				},
			}),
		);
		expect(resolved.branchBlueprints[0].ttlSeconds).toBe(3600);
	});

	test("defaults parent to 'production' for non-production blueprints", () => {
		const resolved = resolveConfig(
			defineConfig({
				project: { name: "x" },
				branchBlueprints: {
					production: {},
					preview: { pattern: "preview-*" },
				},
			}),
		);
		const byKey = new Map(resolved.branchBlueprints.map((b) => [b.key, b]));
		expect(byKey.get("production")?.parent).toBeUndefined();
		expect(byKey.get("preview")?.parent).toBe("production");
	});

	test("respects explicit parent", () => {
		const resolved = resolveConfig(
			defineConfig({
				project: { name: "x" },
				branchBlueprints: {
					production: {},
					staging: {},
					feature: { parent: "staging" },
				},
			}),
		);
		expect(
			resolved.branchBlueprints.find((b) => b.key === "feature")?.parent,
		).toBe("staging");
	});
});

describe("normalizeRegion", () => {
	test.each([
		["us-east-1", "aws-us-east-1"],
		["eu-central-1", "aws-eu-central-1"],
		["aws-us-east-1", "aws-us-east-1"],
		["gcp-us-east1", "gcp-us-east1"],
		["azure-eastus", "azure-eastus"],
	])("normalizeRegion(%s) === %s", (input, expected) => {
		expect(normalizeRegion(input)).toBe(expected);
	});
});
