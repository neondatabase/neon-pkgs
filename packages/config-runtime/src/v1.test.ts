import { describe, expect, test } from "vitest";
import * as v1 from "./v1.js";
import {
	apply,
	buildFunctionBundle,
	bundleAsIs,
	defineConfig,
	inspect,
	plan,
	pullConfig,
	pushConfig,
	resolveEsbuildEntry,
	zipFunctionBundle,
} from "./v1.js";

describe("config-runtime v1 surface", () => {
	test("exports the imperative operations, engine, and bundler", () => {
		expect(inspect).toBeTypeOf("function");
		expect(plan).toBeTypeOf("function");
		expect(apply).toBeTypeOf("function");
		expect(pushConfig).toBeTypeOf("function");
		expect(pullConfig).toBeTypeOf("function");
		expect(buildFunctionBundle).toBeTypeOf("function");
		expect(bundleAsIs).toBeTypeOf("function");
		expect(resolveEsbuildEntry).toBeTypeOf("function");
		expect(zipFunctionBundle).toBeTypeOf("function");
		expect(
			"resolveFunctionArchive" in v1,
			"old dispatcher name must not remain on v1",
		).toBe(false);
	});

	test("re-exports defineConfig from @neon/config for one-stop deploy scripts", () => {
		const config = defineConfig({
			branch: (branch) => ({
				parent: branch.name === "main" ? undefined : "main",
			}),
		});
		expect(config.branch?.({ name: "dev", exists: false })).toEqual({
			parent: "main",
		});
	});
});
