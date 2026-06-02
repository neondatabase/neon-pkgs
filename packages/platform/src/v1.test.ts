import { describe, expect, test } from "vitest";
import { defineConfig, pullConfig, pushConfig } from "./v1.js";

describe("v1 surface", () => {
	test("exports branch policy helpers", () => {
		const config = defineConfig((branch) => ({
			parent: branch.name === "main" ? undefined : "main",
		}));
		expect(config({ name: "dev", exists: false })).toEqual({
			parent: "main",
		});
		expect(pushConfig).toBeTypeOf("function");
		expect(pullConfig).toBeTypeOf("function");
	});
});
