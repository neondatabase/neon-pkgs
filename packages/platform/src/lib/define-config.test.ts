import { describe, expect, test } from "vitest";
import {
	defineConfig,
	normalizeRegion,
	resolveConfig,
} from "./define-config.js";
import { ConfigValidationError } from "./errors.js";
import type { Config } from "./types.js";

describe("defineConfig", () => {
	test("accepts a minimal project-only config", () => {
		// Widen via the `Config` type so the test can assert on absent optional fields —
		// `defineConfig`'s `<const C>` generic preserves literal types, so `cfg.branches`
		// wouldn't even exist on the narrow inferred return type when the input omits it.
		const cfg: Config = defineConfig({ project: { name: "my-app" } });
		expect(cfg.project.name).toBe("my-app");
		expect(cfg.branches).toBeUndefined();
		expect(cfg.branchBlueprints).toBeUndefined();
	});

	test("preserves the features literal so NeonEnv<C> can narrow", () => {
		const cfg = defineConfig({
			project: { name: "my-app" },
			features: { auth: true },
		});
		// Compile-time check — the literal `true` must flow through, otherwise the
		// conditional NeonEnv types collapse to the unconditional shape.
		const _check: true | undefined = cfg.features?.auth;
		void _check;
		expect(cfg.features?.auth).toBe(true);
	});

	test("freezes returned objects", () => {
		const cfg = defineConfig({
			project: { name: "my-app", region: "aws-us-east-1" },
			branches: {
				production: { computeSettings: { autoscalingLimitMaxCu: 1 } },
			},
			branchBlueprints: {
				preview: { pattern: "preview-*", ttl: "1h" },
			},
		});
		expect(Object.isFrozen(cfg)).toBe(true);
		expect(Object.isFrozen(cfg.project)).toBe(true);
		expect(Object.isFrozen(cfg.branches)).toBe(true);
		expect(Object.isFrozen(cfg.branches?.production)).toBe(true);
		expect(Object.isFrozen(cfg.branchBlueprints)).toBe(true);
		expect(Object.isFrozen(cfg.branchBlueprints?.preview)).toBe(true);
	});

	test("aggregates multiple validation issues into one error", () => {
		expect(() =>
			defineConfig({
				project: { name: "  ", region: "BAD" } as never,
				branches: {
					"foo bar": {},
					selfref: { parent: "selfref" },
				},
				branchBlueprints: {
					preview: { pattern: "preview-*", ttl: "abc" } as never,
				},
			}),
		).toThrow(ConfigValidationError);
		try {
			defineConfig({
				project: { name: "" } as never,
				branches: { "bad name!": {} },
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
				branches: { production: { whatevs: 1 } as never },
			}),
		).toThrow(/unknown key/);
		expect(() =>
			defineConfig({
				project: { name: "x" },
				branchBlueprints: {
					preview: { pattern: "preview-*", whatevs: 1 } as never,
				},
			}),
		).toThrow(/unknown key/);
	});

	test("rejects parent referencing itself", () => {
		expect(() =>
			defineConfig({
				project: { name: "x" },
				branches: {
					production: { parent: "production" },
				},
			}),
		).toThrow(/must not reference itself/);
	});

	test("rejects parent pointing at a wildcard pattern", () => {
		expect(() =>
			defineConfig({
				project: { name: "x" },
				branches: {
					production: {},
					feature: { parent: "preview-*" },
				},
			}),
		).toThrow(/must be a concrete branch name/);
	});

	test("rejects a blueprint parent pointing at another blueprint key", () => {
		expect(() =>
			defineConfig({
				project: { name: "x" },
				branchBlueprints: {
					preview: { pattern: "preview-*" },
					feature: { pattern: "feat-*", parent: "preview" },
				},
			}),
		).toThrow(/concrete branch/);
	});

	test("allows a blueprint parent that matches a `branches` key", () => {
		const cfg = defineConfig({
			project: { name: "x" },
			branches: { production: {} },
			branchBlueprints: {
				preview: { pattern: "preview-*", parent: "production" },
			},
		});
		expect(cfg.branchBlueprints?.preview.parent).toBe("production");
	});

	test("allows parent that is a literal branch name not in branches", () => {
		const cfg = defineConfig({
			project: { name: "x" },
			branchBlueprints: {
				feature: { pattern: "feat-*", parent: "main" },
			},
		});
		expect(cfg.branchBlueprints?.feature.parent).toBe("main");
	});

	test("rejects ttl with invalid units", () => {
		expect(() =>
			defineConfig({
				project: { name: "x" },
				branchBlueprints: {
					preview: { pattern: "preview-*", ttl: "1mo" },
				} as never,
			}),
		).toThrow(/ttl:/);
	});

	test("accepts ttl as positive integer (interpreted as seconds)", () => {
		const cfg = defineConfig({
			project: { name: "x" },
			branchBlueprints: {
				preview: { pattern: "preview-*", ttl: 3600 },
			},
		});
		expect(cfg.branchBlueprints?.preview.ttl).toBe(3600);
	});

	test("rejects blueprint without a pattern", () => {
		expect(() =>
			defineConfig({
				project: { name: "x" },
				branchBlueprints: { preview: {} } as never,
			}),
		).toThrow(/pattern/);
	});

	test("rejects a blueprint whose pattern has no wildcard", () => {
		expect(() =>
			defineConfig({
				project: { name: "x" },
				branchBlueprints: {
					preview: { pattern: "preview" },
				},
			}),
		).toThrow(/wildcard/);
	});

	test("rejects a branches entry whose key is not a valid branch name", () => {
		expect(() =>
			defineConfig({
				project: { name: "x" },
				branches: { "bad name!": {} },
			}),
		).toThrow(/not a valid branch name/);
	});

	test("rejects a branches entry whose key contains a wildcard", () => {
		expect(() =>
			defineConfig({
				project: { name: "x" },
				branches: { "preview-*": {} },
			}),
		).toThrow(/concrete branch name/);
	});

	test("rejects key collisions between branches and branchBlueprints", () => {
		expect(() =>
			defineConfig({
				project: { name: "x" },
				branches: { preview: {} },
				branchBlueprints: { preview: { pattern: "preview-*" } },
			}),
		).toThrow(/collides with a key in `branches`/);
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
				branches: {
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
				branches: {
					production: {
						computeSettings: { suspendTimeout: "30s" },
					},
				},
			}),
		).toThrow(/suspend timeout must be between 60 and 604800 seconds/);

		expect(() =>
			defineConfig({
				project: { name: "x" },
				branches: {
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
				branches: {
					production: {
						computeSettings: { suspendTimeout: undefined },
					},
				},
			}),
		).not.toThrow();
		expect(() =>
			defineConfig({
				project: { name: "x" },
				branches: {
					production: {
						computeSettings: { suspendTimeout: false },
					},
				},
			}),
		).not.toThrow();
		expect(() =>
			defineConfig({
				project: { name: "x" },
				branches: {
					production: {
						computeSettings: { suspendTimeout: "5m" },
					},
				},
			}),
		).not.toThrow();
	});

	test("accepts the `protected` flag on a branch", () => {
		const cfg = defineConfig({
			project: { name: "x" },
			branches: { production: { protected: true } },
		});
		expect(cfg.branches?.production.protected).toBe(true);
	});
});

describe("resolveConfig", () => {
	test("flattens branches and blueprints with their keys", () => {
		const resolved = resolveConfig(
			defineConfig({
				project: { name: "x" },
				branches: { production: {} },
				branchBlueprints: { preview: { pattern: "preview-*" } },
			}),
		);
		expect(resolved.branches.map((b) => b.name)).toEqual(["production"]);
		expect(resolved.branchBlueprints.map((b) => b.pattern)).toEqual([
			"preview-*",
		]);
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

	test("defaults parent to 'production' for non-production branches/blueprints", () => {
		const resolved = resolveConfig(
			defineConfig({
				project: { name: "x" },
				branches: { production: {}, staging: {} },
				branchBlueprints: { preview: { pattern: "preview-*" } },
			}),
		);
		const branchByKey = new Map(resolved.branches.map((b) => [b.key, b]));
		const blueprintByKey = new Map(
			resolved.branchBlueprints.map((b) => [b.key, b]),
		);
		expect(branchByKey.get("production")?.parent).toBeUndefined();
		expect(branchByKey.get("staging")?.parent).toBe("production");
		expect(blueprintByKey.get("preview")?.parent).toBe("production");
	});

	test("respects explicit parent", () => {
		const resolved = resolveConfig(
			defineConfig({
				project: { name: "x" },
				branches: {
					production: {},
					staging: {},
					feature: { parent: "staging" },
				},
			}),
		);
		expect(resolved.branches.find((b) => b.key === "feature")?.parent).toBe(
			"staging",
		);
	});

	test("defaults `protected` to false", () => {
		const resolved = resolveConfig(
			defineConfig({
				project: { name: "x" },
				branches: { production: {} },
			}),
		);
		expect(resolved.branches[0].protected).toBe(false);
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
