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
		expect(resolved.dataApiPolicy).toBe("disabled");
	});

	test("omits Data API when the policy does not mention it", () => {
		const config = defineConfig({});
		const resolved = resolveConfig(config, {
			name: "dev-a",
			exists: false,
		});
		expect(resolved.dataApiEnabled).toBe(false);
		expect(resolved.dataApiPolicy).toBe("omitted");
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
					bundler: "esbuild",
				},
			],
			buckets: [{ name: "uploads", access: "private" }],
			aiGatewayEnabled: true,
		});
	});

	test("resolves a bare externalPackages string to includeFiles: true", () => {
		const config = defineConfig({
			preview: {
				functions: {
					fn1: {
						name: "Hello World",
						source: "./functions/hello-world.ts",
						externalPackages: ["sharp", "@mongodb-js/zstd"],
					},
				},
			},
		});
		const resolved = resolveConfig(config, { name: "main", exists: true });
		expect(resolved.preview?.functions).toEqual([
			{
				slug: "fn1",
				name: "Hello World",
				source: "./functions/hello-world.ts",
				env: {},
				externalPackages: [
					{ name: "sharp", includeFiles: true },
					{ name: "@mongodb-js/zstd", includeFiles: true },
				],
				runtime: "nodejs24",
				bundler: "esbuild",
			},
		]);
	});

	test("carries includeFiles: false through from the object form", () => {
		const config = defineConfig({
			preview: {
				functions: {
					fn1: {
						name: "Hello",
						source: "./hello.ts",
						externalPackages: [
							"sharp",
							{ name: "canvas", includeFiles: false },
						],
					},
				},
			},
		});
		const resolved = resolveConfig(config, { name: "main", exists: true });
		expect(resolved.preview?.functions[0]?.externalPackages).toEqual([
			{ name: "sharp", includeFiles: true },
			{ name: "canvas", includeFiles: false },
		]);
	});

	test("treats an explicit includeFiles: true the same as the bare string", () => {
		const config = defineConfig({
			preview: {
				functions: {
					fn1: {
						name: "Hello",
						source: "./hello.ts",
						externalPackages: [
							{ name: "sharp", includeFiles: true },
						],
					},
				},
			},
		});
		const resolved = resolveConfig(config, { name: "main", exists: true });
		expect(resolved.preview?.functions[0]?.externalPackages).toEqual([
			{ name: "sharp", includeFiles: true },
		]);
	});

	test("omits externalPackages entirely when the policy does not declare it", () => {
		const config = defineConfig({
			preview: {
				functions: { fn1: { name: "Hello", source: "./hello.ts" } },
			},
		});
		const resolved = resolveConfig(config, { name: "main", exists: true });
		// Absent rather than `[]`. The bundler keys the stage-files path off there being a
		// shipping entry, and an undeclared policy must produce the archive it always did.
		expect(resolved.preview?.functions[0]).not.toHaveProperty(
			"externalPackages",
		);
	});

	test("defaults bundler to esbuild when the policy omits it", () => {
		const config = defineConfig({
			preview: {
				functions: { fn1: { name: "Hello", source: "./hello.ts" } },
			},
		});
		const resolved = resolveConfig(config, { name: "main", exists: true });
		expect(resolved.preview?.functions[0]?.bundler).toBe("esbuild");
	});

	test("carries a none bundler through with a directory source", () => {
		const config = defineConfig({
			preview: {
				functions: {
					fn1: {
						name: "Mastra",
						source: "./.mastra/output",
						bundler: "none",
					},
				},
			},
		});
		const resolved = resolveConfig(config, { name: "main", exists: true });
		expect(resolved.preview?.functions[0]).toMatchObject({
			source: "./.mastra/output",
			bundler: "none",
		});
	});

	test("carries an inline function bundler through untouched", () => {
		const bundler = async () => ({ "index.mjs": new Uint8Array() });
		const config = defineConfig({
			preview: {
				functions: {
					fn1: { name: "Custom", source: "./build", bundler },
				},
			},
		});
		const resolved = resolveConfig(config, { name: "main", exists: true });
		expect(resolved.preview?.functions[0]?.bundler).toBe(bundler);
	});

	test("rejects externalPackages together with a non-esbuild bundler", () => {
		expect(() =>
			defineConfig({
				preview: {
					functions: {
						fn1: {
							name: "Mastra",
							source: "./.mastra/output",
							bundler: "none",
							externalPackages: ["sharp"],
						},
					},
				},
			}),
		).toThrow(/externalPackages only applies to the "esbuild" bundler/);
	});

	test("rejects an empty externalPackages list with bundler none", () => {
		expect(() =>
			defineConfig({
				preview: {
					functions: {
						fn1: {
							name: "Mastra",
							source: "./.mastra/output",
							bundler: "none",
							externalPackages: [],
						},
					},
				},
			}),
		).toThrow(/externalPackages only applies to the "esbuild" bundler/);
	});

	test("rejects the retired zip-directory bundler name", () => {
		expect(() =>
			defineConfig({
				preview: {
					functions: {
						fn1: {
							name: "Mastra",
							source: "./.mastra/output",
							bundler: "zip-directory" as never,
						},
					},
				},
			}),
		).toThrow(/bundler must be "esbuild", "none"/);
	});

	test("copies externalPackages so mutating the policy array cannot reach the resolved config", () => {
		const externalPackages = ["microsandbox"];
		const config = defineConfig({
			preview: {
				functions: {
					fn1: {
						name: "Hello",
						source: "./hello.ts",
						externalPackages,
					},
				},
			},
		});
		const resolved = resolveConfig(config, { name: "main", exists: true });
		externalPackages.push("mutated-after-resolve");
		expect(resolved.preview?.functions[0]?.externalPackages).toEqual([
			{ name: "microsandbox", includeFiles: true },
		]);
	});

	test("applies per-branch function runtime tuning", () => {
		const config = defineConfig({
			preview: {
				functions: {
					hello: { name: "Hello", source: "./hello.ts" },
				},
			},
			branch: () => ({
				preview: { functions: { hello: { runtime: "nodejs24" } } },
			}),
		});
		const resolved = resolveConfig(config, {
			name: "main",
			exists: true,
		});
		expect(resolved.preview?.functions[0]).toMatchObject({
			slug: "hello",
			runtime: "nodejs24",
		});
		expect(resolved.preview?.functions[0]).not.toHaveProperty("memoryMib");
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
						dev: { port: 8787 },
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
		// Faithful repro of the CLI scenario: a `neon.ts` writing `test: process.env.TEST`
		// with TEST unset. `neon.ts` is evaluated (not type-checked) by neonctl via jiti, so
		// the value arrives as a runtime `undefined`. The `@ts-expect-error` documents that the
		// type system *also* rejects it (the env value must be a defined string).
		const unsetEnvValue =
			process.env.NEON_PKGS_DEFINITELY_UNSET_ENV_VAR_FOR_TEST;
		let caught: unknown;
		try {
			defineConfig({
				preview: {
					functions: {
						hello: {
							name: "Hello",
							source: "./hello.ts",
							// @ts-expect-error process.env.X is `string | undefined`; here it is unset.
							env: { test: unsetEnvValue },
						},
					},
				},
			});
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(ConfigValidationError);
		if (!(caught instanceof ConfigValidationError)) throw caught;

		// The user-visible message is exactly what the CLI prints.
		expect(caught.message).toContain("Invalid Neon config:");
		const issue = caught.issues.join("\n");
		// Points at the exact path…
		expect(issue).toContain("preview.functions.hello.env.test");
		// …names the offending function and env key explicitly…
		expect(issue).toContain('Environment variable "test"');
		expect(issue).toContain('function "hello"');
		// …explains the likely cause + a fix…
		expect(issue).toContain("process.env");
		expect(issue).toContain("omit the key from neon.ts");
		expect(issue).not.toContain('?? ""');
		// …and drops zod's opaque default.
		expect(issue).not.toContain(
			"Invalid input: expected string, received undefined",
		);
	});

	test("names the correct function and key when one of several env values is undefined", () => {
		// Guards the path-extraction logic: the message must identify the *specific* function
		// and key that is undefined, not the first function or a hardcoded name.
		let caught: unknown;
		try {
			defineConfig({
				preview: {
					functions: {
						alpha: {
							name: "Alpha",
							source: "./alpha.ts",
							env: { OK: "present" },
						},
						beta: {
							name: "Beta",
							source: "./beta.ts",
							env: {
								OK: "present",
								// @ts-expect-error simulates an unset process.env.SECRET_TOKEN.
								secretToken: undefined,
							},
						},
					},
				},
			});
		} catch (error) {
			caught = error;
		}
		expect(caught).toBeInstanceOf(ConfigValidationError);
		if (!(caught instanceof ConfigValidationError)) throw caught;
		const issue = caught.issues.join("\n");
		expect(issue).toContain("preview.functions.beta.env.secretToken");
		expect(issue).toContain('Environment variable "secretToken"');
		expect(issue).toContain('function "beta"');
		// The healthy function/keys must not be implicated.
		expect(issue).not.toContain('function "alpha"');
		expect(issue).not.toContain('"OK"');
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
			preview: { functions: { ghost: { runtime: "nodejs24" } } },
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
		// Only the statically declared `hello` is resolved; the ghost slug is dropped.
		expect(resolved.preview?.functions.map((f) => f.slug)).toEqual([
			"hello",
		]);
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
				preview: { functions: { goodbye: { runtime: "nodejs24" } } },
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
			// @ts-expect-error `source` is static; tuning only sets runtime.
			branch: () => ({
				preview: { functions: { hello: { source: "./other.ts" } } },
			}),
		});
	});

	test("the branch closure cannot tune function memory", () => {
		defineConfig({
			preview: { functions: { hello: { name: "H", source: "./h.ts" } } },
			// @ts-expect-error function memory is fixed at 2048 and not configurable.
			branch: () => ({
				preview: { functions: { hello: { memoryMib: 512 } } },
			}),
		});
	});

	test("the preview block accepts all of its declared members (aiGateway/functions/buckets)", () => {
		// Regression: when `preview` was typed as the bare generic `Preview`, editors saw
		// `{} | undefined` and offered no member hints. Intersecting with `PreviewInput` keeps
		// the field's full shape, so every declared member type-checks in place.
		defineConfig({
			preview: {
				aiGateway: { enabled: true },
				functions: { hello: { name: "H", source: "./h.ts" } },
				buckets: { uploads: { access: "public_read" } },
			},
		});
	});

	test("the preview block rejects an unknown member (type + runtime)", () => {
		expect(() =>
			defineConfig({
				// @ts-expect-error `gateway` is not a PreviewInput member (it's `aiGateway`).
				preview: { gateway: { enabled: true } },
			}),
		).toThrow(ConfigValidationError);
	});

	test("a bucket access level is constrained to the known literals (type + runtime)", () => {
		expect(() =>
			defineConfig({
				preview: {
					// @ts-expect-error access is "private" | "public_read", not an arbitrary string.
					buckets: { uploads: { access: "world_readable" } },
				},
			}),
		).toThrow(ConfigValidationError);
	});

	test("intersecting the generics still infers function slugs for the branch closure", () => {
		// The autocomplete fix (Preview & PreviewInput) must not weaken slug inference: the
		// closure can tune a declared slug but not an undeclared one.
		defineConfig({
			preview: { functions: { hello: { name: "H", source: "./h.ts" } } },
			branch: () => ({
				preview: { functions: { hello: { runtime: "nodejs24" } } },
			}),
		});
		defineConfig({
			preview: { functions: { hello: { name: "H", source: "./h.ts" } } },
			// @ts-expect-error "bye" is not a declared function slug.
			branch: () => ({
				preview: { functions: { bye: { runtime: "nodejs24" } } },
			}),
		});
	});
});

describe("defineConfig — Data API config", () => {
	test("resolves a bare `dataApi: true` to a neon-auth integration", () => {
		const config = defineConfig({ auth: true, dataApi: true });
		const resolved = resolveConfig(config, { name: "main", exists: true });
		expect(resolved.dataApiEnabled).toBe(true);
		expect(resolved.dataApi).toEqual({ authProvider: "neon" });
	});

	test("resolves neon-auth settings (camelCase, undefined dropped)", () => {
		const config = defineConfig({
			auth: true,
			dataApi: {
				settings: {
					dbMaxRows: 1000,
					dbSchemas: ["public", "api"],
					dbExtraSearchPath: undefined,
				},
			},
		});
		const resolved = resolveConfig(config, { name: "main", exists: true });
		expect(resolved.dataApi).toEqual({
			authProvider: "neon",
			settings: { dbMaxRows: 1000, dbSchemas: ["public", "api"] },
		});
	});

	test("resolves external-auth wiring without requiring Neon Auth", () => {
		const config = defineConfig({
			dataApi: {
				authProvider: "external",
				jwksUrl: "https://idp.example.com/.well-known/jwks.json",
				providerName: "Clerk",
				jwtAudience: "my-api",
				settings: { openapiMode: "ignore-privileges" },
			},
		});
		const resolved = resolveConfig(config, { name: "main", exists: true });
		expect(resolved.dataApi).toEqual({
			authProvider: "external",
			jwksUrl: "https://idp.example.com/.well-known/jwks.json",
			providerName: "Clerk",
			jwtAudience: "my-api",
			settings: { openapiMode: "ignore-privileges" },
		});
	});

	test("omits the resolved dataApi block when disabled", () => {
		const config = defineConfig({ dataApi: false });
		const resolved = resolveConfig(config, { name: "main", exists: true });
		expect(resolved.dataApiEnabled).toBe(false);
		expect(resolved.dataApi).toBeUndefined();
	});

	test("throws at runtime when a neon Data API is enabled without auth", () => {
		// Bypass the static guard (as a non-typed / JS caller would) to exercise the zod check.
		expect(() => defineConfig({ dataApi: true } as never)).toThrow(
			ConfigValidationError,
		);
	});

	test("throws at runtime when external-only fields are used with neon auth", () => {
		expect(() =>
			defineConfig({
				auth: true,
				dataApi: { jwksUrl: "https://x" } as never,
			}),
		).toThrow(ConfigValidationError);
	});

	// ─── Static (type-level) guarantees ─────────────────────────────────────────

	test("static: external-only fields are forbidden with neon auth", () => {
		// Type error (jwksUrl is `never` on the neon variant) AND a runtime rejection.
		expect(() =>
			defineConfig({
				auth: true,
				dataApi: {
					authProvider: "neon",
					// @ts-expect-error jwksUrl is only allowed with authProvider: "external".
					jwksUrl: "https://idp.example.com/jwks.json",
				},
			}),
		).toThrow(ConfigValidationError);
	});

	test("static: a neon Data API requires top-level auth", () => {
		expect(() =>
			// @ts-expect-error dataApi (neon) needs `auth` enabled — `auth` is now required.
			defineConfig({ dataApi: true }),
		).toThrow(ConfigValidationError);
		expect(() =>
			// @ts-expect-error same, with the object form.
			defineConfig({ dataApi: { settings: { dbMaxRows: 10 } } }),
		).toThrow(ConfigValidationError);
		// These satisfy it and must type-check (and not throw):
		defineConfig({ auth: true, dataApi: true });
		defineConfig({ auth: {}, dataApi: { settings: { dbMaxRows: 10 } } });
		// (An explicit `auth: false` is caught at runtime by the zod cross-field check.)
	});

	test("static: an external Data API does not require auth", () => {
		defineConfig({
			dataApi: {
				authProvider: "external",
				jwksUrl: "https://idp.example.com/jwks.json",
			},
		});
	});
});
