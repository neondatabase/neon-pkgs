import { describe, expect, test } from "vitest";
import {
	apply,
	defineConfig,
	inspect,
	plan,
	pullConfig,
	pushConfig,
} from "./v1.js";

describe("v1 surface", () => {
	test("exports the config operations and policy helper", () => {
		const config = defineConfig((branch) => ({
			parent: branch.name === "main" ? undefined : "main",
		}));
		expect(config({ name: "dev", exists: false })).toEqual({
			parent: "main",
		});
		expect(inspect).toBeTypeOf("function");
		expect(plan).toBeTypeOf("function");
		expect(apply).toBeTypeOf("function");
		expect(pushConfig).toBeTypeOf("function");
		expect(pullConfig).toBeTypeOf("function");
	});
});
