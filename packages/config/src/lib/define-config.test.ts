import { describe, expect, test } from "vitest";
import { defineConfig, resolveConfig } from "./define-config.js";
import { ConfigValidationError } from "./errors.js";
import type { BranchTuning, BranchTuningFn } from "./types.js";

describe("defineConfig", () => {
	test("accepts a static policy object and freezes it", () => {
		const config = defineConfig({
			auth: { enabled: true },
			branch: (branch) => ({ protected: branch.name === "main" }),
		});
		expect(typeof config).toBe("object");
		expect(config.auth).toEqual({ enabled: true });
		expect(Object.isFrozen(config)).toBe(true);
	});

	test("rejects a function config so the old closure form is not accepted", () => {
		expect(() =>
			defineConfig(((branch: { name: string }) => ({
				parent: branch.name,
			})) as never),
		).toThrow(ConfigValidationError);
	});

	test("rejects an unknown top-level key", () => {
		expect(() => defineConfig({ project: { name: "x" } } as never)).toThrow(
			ConfigValidationError,
		);
	});

	test("rejects a non-object input", () => {
		expect(() => defineConfig(null as never)).toThrow(
			ConfigValidationError,
		);
		expect(() => defineConfig(42 as never)).toThrow(ConfigValidationError);
	});

	test("rejects a `branch` that is not a function", () => {
		expect(() => defineConfig({ branch: {} as never })).toThrow(
			ConfigValidationError,
		);
	});
});

describe("resolveConfig", () => {
	test("normalizes static services and branch tuning", () => {
		const config = defineConfig({
			auth: {},
			dataApi: {},
			branch: () => ({
				parent: "main",
				ttl: "1h",
				protected: true,
				postgres: { computeSettings: { autoscalingLimitMaxCu: 2 } },
			}),
		});
		const resolved = resolveConfig(config, {
			name: "dev-a",
			exists: false,
		});
		expect(resolved).toMatchObject({
			parent: "main",
			ttlSeconds: 3600,
			protected: true,
			authEnabled: true,
			dataApiEnabled: true,
			postgres: { computeSettings: { autoscalingLimitMaxCu: 2 } },
		});
	});

	test("treats boolean and explicit service false as disabled", () => {
		const config = defineConfig({
			auth: false,
			dataApi: { enabled: false },
		});
		const resolved = resolveConfig(config, {
			name: "dev-a",
			exists: false,
		});
		expect(resolved.authEnabled).toBe(false);
		expect(resolved.dataApiEnabled).toBe(false);
	});

	test("treats `auth: true` as enabled", () => {
		const config = defineConfig({ auth: true });
		expect(
			resolveConfig(config, { name: "main", exists: true }).authEnabled,
		).toBe(true);
	});

	test("reports invalid branch tuning output", () => {
		const config = defineConfig({
			branch: () => ({ parent: "preview-*" }),
		});
		expect(() =>
			resolveConfig(config, { name: "dev", exists: false }),
		).toThrow(ConfigValidationError);
	});

	test("resolves preview functions with deploy defaults and buckets with private access", () => {
		const config = defineConfig({
			preview: {
				functions: {
					fn1: {
						name: "Hello World",
						source: "./functions/hello-world.ts",
						env: { RESEND_API_KEY: "re_abc" },
					},
				},
				buckets: { uploads: {} },
				aiGateway: { enabled: true },
			},
		});
		const resolved = resolveConfig(config, {
			name: "preview-1",
			exists: false,
		});
		expect(resolved.preview).toEqual({
			functions: [
				{
					slug: "fn1",
					name: "Hello World",
					source: "./functions/hello-world.ts",
					env: { RESEND_API_KEY: "re_abc" },
					runtime: "nodejs24",
					memoryMib: 512,
				},
			],
			buckets: [{ name: "uploads", access: "private" }],
			aiGatewayEnabled: true,
		});
	});

	test("applies per-branch function tuning (memoryMib / runtime) over defaults", () => {
		const config = defineConfig({
			preview: {
				functions: {
					hello: { name: "Hello", source: "./hello.ts" },
				},
			},
			branch: () => ({
				preview: { functions: { hello: { memoryMib: 2048 } } },
			}),
		});
		const resolved = resolveConfig(config, {
			name: "main",
			exists: true,
		});
		expect(resolved.preview?.functions[0]).toMatchObject({
			slug: "hello",
			memoryMib: 2048,
			runtime: "nodejs24",
		});
	});

	test("treats aiGateway enabled:false as disabled", () => {
		const config = defineConfig({
			preview: { aiGateway: { enabled: false } },
		});
		const resolved = resolveConfig(config, {
			name: "preview-1",
			exists: false,
		});
		expect(resolved.preview?.aiGatewayEnabled).toBe(false);
	});

	test("passes a function dev block through untouched", () => {
		const config = defineConfig({
			preview: {
				functions: {
					hello: {
						name: "Hello",
						source: "./hello.ts",
						dev: { port: 8787, portless: true },
					},
				},
			},
		});
		const resolved = resolveConfig(config, {
			name: "preview-1",
			exists: false,
		});
		expect(resolved.preview?.functions[0].dev).toEqual({
			port: 8787,
			portless: true,
		});
	});

	test("omits dev from the resolved function when not provided", () => {
		const config = defineConfig({
			preview: {
				functions: { hello: { name: "Hello", source: "./hello.ts" } },
			},
		});
		const resolved = resolveConfig(config, {
			name: "preview-1",
			exists: false,
		});
		expect(resolved.preview?.functions[0]).not.toHaveProperty("dev");
	});

	test("rejects a function env value that is undefined (e.g. unset process.env) at definition time", () => {
		expect(() =>
			defineConfig({
				preview: {
					functions: {
						hello: {
							name: "Hello",
							source: "./hello.ts",
							// Simulates `RESEND_API_KEY: process.env.RESEND_API_KEY` when unset.
							env: {
								RESEND_API_KEY: undefined as unknown as string,
							},
						},
					},
				},
			}),
		).toThrow(ConfigValidationError);
	});

	test("rejects an invalid function slug (record key) at definition time", () => {
		expect(() =>
			defineConfig({
				preview: {
					functions: {
						"Hello World": { name: "Bad", source: "./x.ts" },
					},
				},
			}),
		).toThrow(ConfigValidationError);
	});

	test("rejects a hyphenated function slug (only letters and digits allowed)", () => {
		expect(() =>
			defineConfig({
				preview: {
					functions: {
						"hello-world": { name: "H", source: "./x.ts" },
					},
				},
			}),
		).toThrow(ConfigValidationError);
	});

	test("rejects a function slug longer than 20 chars", () => {
		expect(() =>
			defineConfig({
				preview: {
					functions: {
						["a".repeat(21)]: { name: "L", source: "./x.ts" },
					},
				},
			}),
		).toThrow(ConfigValidationError);
	});

	test("accepts a valid alphanumeric function slug", () => {
		const config = defineConfig({
			preview: { functions: { fn1: { name: "OK", source: "./x.ts" } } },
		});
		expect(
			resolveConfig(config, { name: "preview-1", exists: false }).preview
				?.functions[0].slug,
		).toBe("fn1");
	});

	test("ignores branch tuning for a function slug not declared statically", () => {
		// The type system blocks unknown slugs in the closure (see the type-constraint
		// tests); at runtime an unknown slug that slips past types is simply ignored — it
		// can never fabricate a function that isn't statically declared. We bypass the
		// slug-narrowing guard via `unknown` (the value is still a well-typed BranchTuning).
		const ghostTuning: BranchTuning = {
			preview: { functions: { ghost: { memoryMib: 2048 } } },
		};
		const config = defineConfig({
			preview: {
				functions: { hello: { name: "Hello", source: "./h.ts" } },
			},
			branch: (() => ghostTuning) as unknown as BranchTuningFn<{
				functions: { hello: { name: string; source: string } };
			}>,
		});
		const resolved = resolveConfig(config, { name: "main", exists: true });
		expect(resolved.preview?.functions.map((f) => f.slug)).toEqual([
			"hello",
		]);
		// hello keeps the default memory (the ghost tuning never applied to it).
		expect(resolved.preview?.functions[0].memoryMib).toBe(512);
	});

	test("passes the branch target to the closure for per-branch decisions", () => {
		const config = defineConfig({
			branch: (branch) => ({ protected: branch.name === "main" }),
		});
		expect(
			resolveConfig(config, { name: "main", exists: true }).protected,
		).toBe(true);
		expect(
			resolveConfig(config, { name: "dev", exists: false }).protected,
		).toBe(false);
	});

	test("treats a branch closure returning undefined as no tuning", () => {
		// A closure that returns nothing is not part of the public type (it must return a
		// BranchTuning), but the runtime must treat a stray `undefined` as empty tuning. We
		// bypass the return-type guard via `unknown` rather than fabricating a `void` type.
		const config = defineConfig({
			auth: true,
			branch: (() => undefined) as unknown as BranchTuningFn,
		});
		const resolved = resolveConfig(config, { name: "main", exists: true });
		expect(resolved.authEnabled).toBe(true);
		expect(resolved.parent).toBeUndefined();
		expect(resolved.protected).toBeUndefined();
	});
});

describe("defineConfig type constraints (compile-time)", () => {
	test("the branch closure cannot tune an undeclared function slug", () => {
		defineConfig({
			preview: { functions: { hello: { name: "H", source: "./h.ts" } } },
			// @ts-expect-error "goodbye" is not a declared function slug.
			branch: () => ({
				preview: { functions: { goodbye: { memoryMib: 512 } } },
			}),
		});
	});

	test("the branch closure cannot add a service toggle", () => {
		defineConfig({
			// @ts-expect-error `auth` is a static top-level toggle, not branch tuning.
			branch: () => ({ auth: true }),
		});
	});

	test("the branch closure cannot redeclare a function's source", () => {
		defineConfig({
			preview: { functions: { hello: { name: "H", source: "./h.ts" } } },
			// @ts-expect-error `source` is static; tuning only sets memoryMib/runtime.
			branch: () => ({
				preview: { functions: { hello: { source: "./other.ts" } } },
			}),
		});
	});
});
