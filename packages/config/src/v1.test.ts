import { describe, expect, test } from "vitest";
import {
	defineConfig,
	deploy,
	pull,
	pullConfig,
	pushConfig,
	status,
} from "./v1.js";

describe("v1 surface", () => {
	test("exports the config operations and policy helper", () => {
		const config = defineConfig((branch) => ({
			parent: branch.name === "main" ? undefined : "main",
		}));
		expect(config({ name: "dev", exists: false })).toEqual({
			parent: "main",
		});
		expect(status).toBeTypeOf("function");
		expect(deploy).toBeTypeOf("function");
		expect(pull).toBeTypeOf("function");
		expect(pushConfig).toBeTypeOf("function");
		expect(pullConfig).toBeTypeOf("function");
	});
});
