import { describe, expect, test } from "vitest";
import { loadConfigFromFile } from "./loader.js";
import { makeTempRepo } from "./test-utils.js";

const PLATFORM_SRC = new URL("../v1.ts", import.meta.url).pathname;

describe("loadConfigFromFile", () => {
	test("loads a neon.ts branch policy", async () => {
		const repo = makeTempRepo({
			"neon.ts": `import { defineConfig } from "${PLATFORM_SRC}"; export default defineConfig({ auth: true, branch: (branch) => ({ parent: branch.name === "main" ? undefined : "main" }) });`,
		});
		try {
			const { config, resolvedPath } = await loadConfigFromFile({
				cwd: repo.root,
			});
			expect(resolvedPath.endsWith("neon.ts")).toBe(true);
			expect(config.auth).toBe(true);
			expect(config.branch?.({ name: "dev", exists: false })).toEqual({
				parent: "main",
			});
		} finally {
			repo.cleanup();
		}
	});

	test("fails when config is missing", async () => {
		const repo = makeTempRepo({ "package.json": "{}" });
		try {
			await expect(
				loadConfigFromFile({ cwd: repo.root }),
			).rejects.toThrow("Could not find");
		} finally {
			repo.cleanup();
		}
	});
});
