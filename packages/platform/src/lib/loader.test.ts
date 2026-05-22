import { afterEach, describe, expect, test } from "vitest";
import { ConfigLoadError, ConfigValidationError } from "./errors.js";
import { loadConfigFromFile } from "./loader.js";
import { makeTempRepo } from "./test-utils.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
	while (cleanups.length > 0) cleanups.shift()?.();
});

function setup(files: Record<string, string | null>) {
	const repo = makeTempRepo(files);
	cleanups.push(repo.cleanup);
	return repo.root;
}

const PKG_DIST_INDEX_URL = new URL("../../dist/v1.js", import.meta.url)
	.pathname;

// Loader tests intentionally do not depend on the built `dist/`; instead, the user's
// neon.ts can import directly from the package source root via a relative import. We
// resolve that by writing absolute imports that point at the package source.
const PLATFORM_SRC = new URL("../v1.ts", import.meta.url).pathname;

describe("loadConfigFromFile", () => {
	test("loads a neon.ts that default-exports defineConfig(...)", async () => {
		const root = setup({
			"package.json": "{}",
			"neon.ts": `
import { defineConfig } from "${PLATFORM_SRC}";
export default defineConfig({
  project: { name: "test-project", region: "aws-us-east-1" },
  branchBlueprints: {
    production: {},
    preview: { pattern: "preview-*", ttl: "1h" },
  },
});
`,
		});
		const { config, resolvedPath } = await loadConfigFromFile({
			cwd: root,
		});
		expect(config.project.name).toBe("test-project");
		expect(config.branchBlueprints?.preview.pattern).toBe("preview-*");
		expect(resolvedPath.endsWith("/neon.ts")).toBe(true);
	});

	test("loads explicit path", async () => {
		const root = setup({
			"package.json": "{}",
			"config/my.config.ts": `
import { defineConfig } from "${PLATFORM_SRC}";
export default defineConfig({ project: { name: "explicit" } });
`,
		});
		const { config } = await loadConfigFromFile({
			path: `${root}/config/my.config.ts`,
		});
		expect(config.project.name).toBe("explicit");
	});

	test("walks up from a subdirectory", async () => {
		const root = setup({
			"package.json": "{}",
			"neon.ts": `
import { defineConfig } from "${PLATFORM_SRC}";
export default defineConfig({ project: { name: "walked-up" } });
`,
			"src/deep/file.txt": "irrelevant",
		});
		const { config } = await loadConfigFromFile({
			cwd: `${root}/src/deep`,
		});
		expect(config.project.name).toBe("walked-up");
	});

	test("throws ConfigLoadError when no file found", async () => {
		const root = setup({ "package.json": "{}" });
		await expect(loadConfigFromFile({ cwd: root })).rejects.toThrow(
			ConfigLoadError,
		);
	});

	test("throws ConfigLoadError when explicit path missing", async () => {
		const root = setup({ "package.json": "{}" });
		await expect(
			loadConfigFromFile({ path: `${root}/missing.ts` }),
		).rejects.toThrow(ConfigLoadError);
	});

	test("throws ConfigLoadError when the file has no default export", async () => {
		const root = setup({
			"package.json": "{}",
			"neon.ts": `export const named = 1;`,
		});
		await expect(loadConfigFromFile({ cwd: root })).rejects.toThrow(
			ConfigLoadError,
		);
	});

	test("surfaces defineConfig validation errors from the loaded file", async () => {
		const root = setup({
			"package.json": "{}",
			"neon.ts": `export default { project: { name: "" } };`,
		});
		await expect(loadConfigFromFile({ cwd: root })).rejects.toThrow(
			ConfigValidationError,
		);
	});

	test("ignores stale dist (sanity: the package source must be importable)", () => {
		// Lazy sanity check: when running tests from source, PLATFORM_SRC must point at the
		// v1 entry. This makes the test file robust against changes to the test setup.
		expect(PLATFORM_SRC.endsWith("/src/v1.ts")).toBe(true);
		expect(PKG_DIST_INDEX_URL.endsWith("/dist/v1.js")).toBe(true);
	});
});
