import { describe, expect, test } from "vitest";
import {
	apply,
	buildFunctionBundle,
	defineConfig,
	inspect,
	plan,
	pullConfig,
	pushConfig,
} from "./v1.js";

describe("config-runtime v1 surface", () => {
	test("exports the imperative operations, engine, and bundler", () => {
		expect(inspect).toBeTypeOf("function");
		expect(plan).toBeTypeOf("function");
		expect(apply).toBeTypeOf("function");
		expect(pushConfig).toBeTypeOf("function");
		expect(pullConfig).toBeTypeOf("function");
		expect(buildFunctionBundle).toBeTypeOf("function");
	});

	test("re-exports defineConfig from @neondatabase/config for one-stop deploy scripts", () => {
		const config = defineConfig((branch) => ({
			parent: branch.name === "main" ? undefined : "main",
		}));
		expect(config({ name: "dev", exists: false })).toEqual({
			parent: "main",
		});
	});
});
