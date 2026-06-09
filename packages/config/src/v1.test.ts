import { describe, expect, test } from "vitest";
import {
	createRealNeonApi,
	defineConfig,
	diffConfig,
	loadConfigFromFile,
	resolveConfig,
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
		// Authoring + pure core stays in @neondatabase/config.
		expect(resolveConfig).toBeTypeOf("function");
		expect(diffConfig).toBeTypeOf("function");
		expect(createRealNeonApi).toBeTypeOf("function");
		expect(loadConfigFromFile).toBeTypeOf("function");
	});

	test("does not export the imperative operations (they live in @neondatabase/config-runtime)", async () => {
		const surface = await import("./v1.js");
		expect("apply" in surface).toBe(false);
		expect("plan" in surface).toBe(false);
		expect("inspect" in surface).toBe(false);
		expect("pushConfig" in surface).toBe(false);
		expect("pullConfig" in surface).toBe(false);
	});
});
