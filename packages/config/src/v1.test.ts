import { describe, expect, test } from "vitest";
import {
	createRealNeonApi,
	defineConfig,
	diffConfig,
	errors,
	loadConfigFromFile,
	resolveConfig,
	schemas,
} from "./v1.js";

describe("v1 surface", () => {
	test("exports the authoring helpers, pure diff engine, adapter, and loader", () => {
		const config = defineConfig({
			branch: (branch) => ({
				parent: branch.name === "main" ? undefined : "main",
			}),
		});
		expect(config.branch?.({ name: "dev", exists: false })).toEqual({
			parent: "main",
		});
		// Authoring + pure core stays in @neon/config.
		expect(resolveConfig).toBeTypeOf("function");
		expect(diffConfig).toBeTypeOf("function");
		expect(createRealNeonApi).toBeTypeOf("function");
		expect(loadConfigFromFile).toBeTypeOf("function");
	});

	test("does not export the imperative operations (they live in @neon/config-runtime)", async () => {
		const surface = await import("./v1.js");
		expect("apply" in surface).toBe(false);
		expect("plan" in surface).toBe(false);
		expect("inspect" in surface).toBe(false);
		expect("pushConfig" in surface).toBe(false);
		expect("pullConfig" in surface).toBe(false);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Public value-export surface lock. Removing or renaming an export is a breaking change
// for everyone importing `@neon/config`; these snapshots make that change explicit
// and reviewable rather than silent. (Type-only exports are guarded in `v1.test-d.ts`.)
// ─────────────────────────────────────────────────────────────────────────────

describe("@neon/config public value surface", () => {
	test("v1 value exports are stable", async () => {
		const surface = await import("./v1.js");
		expect(Object.keys(surface).sort()).toMatchInlineSnapshot(`
			[
			  "ConfigLoadError",
			  "ConfigValidationError",
			  "DATA_API_AUTH_PROVIDERS",
			  "ErrorCode",
			  "MissingContextError",
			  "PartialBranchCreateError",
			  "PlatformError",
			  "PushAbortedError",
			  "PushConflictError",
			  "createNeonApiFromOptions",
			  "createRealNeonApi",
			  "credentialScopesSatisfied",
			  "defineConfig",
			  "deriveCredentialScopes",
			  "diffConfig",
			  "errors",
			  "isPartialBranchCreateError",
			  "isPlatformError",
			  "loadConfigFromFile",
			  "resolveApiKey",
			  "resolveConfig",
			  "schemas",
			]
		`);
	});

	test("the `errors` namespace is stable", () => {
		expect(Object.keys(errors).sort()).toMatchInlineSnapshot(`
			[
			  "ConfigLoadError",
			  "ConfigValidationError",
			  "ErrorCode",
			  "MissingContextError",
			  "PartialBranchCreateError",
			  "PlatformError",
			  "PushAbortedError",
			  "PushConflictError",
			  "isPartialBranchCreateError",
			  "isPlatformError",
			]
		`);
	});

	test("the `schemas` namespace is stable", () => {
		expect(Object.keys(schemas).sort()).toMatchInlineSnapshot(`
			[
			  "branchTuning",
			  "bucket",
			  "computeSettings",
			  "config",
			  "dataApi",
			  "dataApiInput",
			  "dataApiSettings",
			  "function",
			  "functionTuning",
			  "postgres",
			  "preview",
			  "service",
			  "serviceInput",
			]
		`);
	});

	test("the default entry point re-exports exactly the v1 surface", async () => {
		const [v1, index] = await Promise.all([
			import("./v1.js"),
			import("./index.js"),
		]);
		expect(Object.keys(index).sort()).toEqual(Object.keys(v1).sort());
	});
});
