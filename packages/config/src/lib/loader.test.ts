import { describe, expect, test } from "vitest";
import { loadConfigFromFile } from "./loader.js";
import { makeTempRepo } from "./test-utils.js";

const PLATFORM_SRC = new URL("../v1.ts", import.meta.url).pathname;

describe("loadConfigFromFile", () => {
	// jiti transpiles the temp `neon.ts` on first import; under CI's `--coverage`
	// instrumentation that cold transpile can take >5s, so give this test a generous
	// timeout (the default 5s flakes in CI even though it runs in ~250ms locally).
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
	}, 30_000);

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

	// A config the user got *wrong* (here: a hyphenated function slug) is rejected by
	// `defineConfig` at module-eval time. The loader must surface that validation error
	// verbatim — with the exact field + rule — and must NOT bury it under the generic
	// "this is usually a TypeScript syntax error" hint, which sent users debugging the
	// wrong thing. This crosses the jiti module boundary, so it also exercises the
	// structural (non-`instanceof`) PlatformError detection.
	test("surfaces a config validation error instead of the generic eval hint", async () => {
		const repo = makeTempRepo({
			"neon.ts": `import { defineConfig } from "${PLATFORM_SRC}"; export default defineConfig({ preview: { functions: { "hello-world": { name: "hello", source: "src/index.ts" } } } });`,
		});
		try {
			const error = await loadConfigFromFile({ cwd: repo.root }).then(
				() => {
					throw new Error("expected loadConfigFromFile to reject");
				},
				(err: unknown) => err,
			);
			const message =
				error instanceof Error ? error.message : String(error);
			expect(message).toContain("Invalid Neon config");
			expect(message).toContain("preview.functions.hello-world");
			expect(message).toContain(
				"function slug must be 1-20 lowercase letters and digits (no hyphens or other characters)",
			);
			// The misleading catch-all hint must be gone for validation errors.
			expect(message).not.toContain(
				"This is usually a TypeScript syntax error",
			);
			expect(message).not.toContain("Failed to evaluate");
		} finally {
			repo.cleanup();
		}
	}, 30_000);

	// The generic hint is still the right call for *genuine* evaluation failures: a
	// runtime exception thrown while the module is being imported is not a config the
	// validator can describe, so we keep pointing the user at "run it with tsx".
	test("keeps the generic eval hint for a real runtime error in the config", async () => {
		const repo = makeTempRepo({
			"neon.ts": `throw new Error("kaboom from neon.ts");`,
		});
		try {
			const error = await loadConfigFromFile({ cwd: repo.root }).then(
				() => {
					throw new Error("expected loadConfigFromFile to reject");
				},
				(err: unknown) => err,
			);
			const message =
				error instanceof Error ? error.message : String(error);
			expect(message).toContain("Failed to evaluate");
			expect(message).toContain("kaboom from neon.ts");
			expect(message).toContain(
				"This is usually a TypeScript syntax error",
			);
		} finally {
			repo.cleanup();
		}
	}, 30_000);
});
