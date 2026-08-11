import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { strFromU8 } from "fflate";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { type BundleDeps, bundleEntry } from "./esbuild";

const require = createRequire(import.meta.url);
// Absolute, CWD- and PATH-independent path to the esbuild CLI shipped with the
// dev checkout. Pinning NEON_ESBUILD_PATH to it makes the binary-path branch
// deterministic in tests.
const ESBUILD_BIN = require.resolve("esbuild/bin/esbuild");

// Explicit npm-mode deps: process.pkg undefined + real esbuild import. Passing
// these explicitly keeps these tests on the in-process module path even if a
// future test setup ever shimmed process.pkg.
const npmDeps: BundleDeps = {
	isPackaged: () => false,
	loadEsbuild: (name: string) => import(name),
};

const withEnv = async (
	value: string,
	fn: () => Promise<void>,
): Promise<void> => {
	const prev = process.env.NEON_ESBUILD_PATH;
	process.env.NEON_ESBUILD_PATH = value;
	try {
		await fn();
	} finally {
		if (prev === undefined) delete process.env.NEON_ESBUILD_PATH;
		else process.env.NEON_ESBUILD_PATH = prev;
	}
};

let dir: string;
beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), "neonctl-esbuild-"));
	writeFileSync(
		join(dir, "helper.ts"),
		'export const greet = () => "hi from helper";\n',
	);
	writeFileSync(
		join(dir, "index.ts"),
		[
			'import { greet } from "./helper";',
			'import { readFileSync } from "node:fs";',
			"export default { greet, readFileSync };",
			"",
		].join("\n"),
	);
	writeFileSync(join(dir, "broken.ts"), "export default {\n");
	// Imports a package that is not installed anywhere, so it can only bundle when the
	// specifier is declared external.
	writeFileSync(
		join(dir, "needs-external.ts"),
		[
			'import { greet } from "./helper";',
			'import { thing } from "not-installed-anywhere";',
			"export default { greet, thing };",
			"",
		].join("\n"),
	);
});
afterAll(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("bundleEntry", () => {
	test("inlines local imports and emits no sourcemap", async () => {
		const { files } = await bundleEntry(join(dir, "index.ts"), npmDeps);
		const js = strFromU8(files["index.mjs"]);
		expect(js).toContain("hi from helper");
		expect(js).not.toContain("./helper");
		// No source map is generated — the Functions runtime never consumes it, so we neither
		// emit `index.mjs.map` nor leave a dangling `sourceMappingURL` link in the bundle.
		expect(js).not.toContain("sourceMappingURL");
		expect(files["index.mjs.map"]).toBeUndefined();
	});

	// Node built-ins stay external on platform:'node'; the createRequire banner is injected
	// so bundled CommonJS deps can `require(...)` inside the ESM output.
	test("keeps node built-ins external and injects a createRequire banner", async () => {
		const js = strFromU8(
			(await bundleEntry(join(dir, "index.ts"), npmDeps)).files[
				"index.mjs"
			],
		);
		expect(js).toContain("node:fs");
		expect(js).toContain("createRequire");
	});

	test("surfaces a bundle error without falling back to a binary search", async () => {
		const source = join(dir, "broken.ts");
		const err = (await bundleEntry(source, npmDeps).catch(
			(e: unknown) => e,
		)) as Error;
		expect(err.message).toContain(
			`Failed to bundle function from ${source}`,
		);
		expect(err.message).not.toContain("esbuild not found");
	});

	test("fails on an unresolvable dependency when externalPackages is not set", async () => {
		// The baseline the option exists to fix: this is the deploy-time bundle failure.
		await expect(
			bundleEntry(join(dir, "needs-external.ts"), npmDeps),
		).rejects.toThrow(/Could not resolve "not-installed-anywhere"/);
	});

	test("externalPackages leaves the named package unbundled and still inlines the rest", async () => {
		const { files } = await bundleEntry(join(dir, "needs-external.ts"), {
			...npmDeps,
			externalPackages: ["not-installed-anywhere"],
		});
		const js = strFromU8(files["index.mjs"]);
		expect(js).toContain("not-installed-anywhere");
		expect(js).toContain("hi from helper");
	});

	test("externalPackages reaches the binary path as --external flags", async () => {
		await withEnv(ESBUILD_BIN, async () => {
			const { files } = await bundleEntry(
				join(dir, "needs-external.ts"),
				{
					isPackaged: () => true,
					loadEsbuild: () =>
						Promise.reject(new Error("should not be called")),
					externalPackages: ["not-installed-anywhere"],
				},
			);
			const js = strFromU8(files["index.mjs"]);
			expect(js).toContain("not-installed-anywhere");
			expect(js).toContain("hi from helper");
		});
	});

	test("externalizes every declared package", async () => {
		writeFileSync(
			join(dir, "needs-both.ts"),
			[
				'import { greet } from "./helper";',
				'import { thing } from "not-installed-anywhere";',
				'import addon from "also-not-installed";',
				"export default { greet, thing, addon };",
				"",
			].join("\n"),
		);
		const { files } = await bundleEntry(join(dir, "needs-both.ts"), {
			...npmDeps,
			externalPackages: ["not-installed-anywhere", "also-not-installed"],
		});
		const js = strFromU8(files["index.mjs"]);
		expect(js).toContain("not-installed-anywhere");
		expect(js).toContain("also-not-installed");
		expect(js).toContain("hi from helper");
	});

	// The metafile is what lets a deploy notice an undeclared native dependency. An
	// externalized package is deliberately absent from it — esbuild never resolved a file
	// for it — while a bundled one appears under its node_modules path.
	test("reports the resolved graph in a metafile on the module path", async () => {
		const { metafile } = await bundleEntry(join(dir, "needs-external.ts"), {
			...npmDeps,
			externalPackages: ["not-installed-anywhere"],
		});
		const inputs = Object.keys(metafile?.inputs ?? {});
		expect(inputs.some((i) => i.endsWith("helper.ts"))).toBe(true);
		expect(inputs.some((i) => i.includes("not-installed-anywhere"))).toBe(
			false,
		);
	});

	test("reports the resolved graph in a metafile on the binary path too", async () => {
		await withEnv(ESBUILD_BIN, async () => {
			const { metafile } = await bundleEntry(
				join(dir, "needs-external.ts"),
				{
					isPackaged: () => true,
					loadEsbuild: () =>
						Promise.reject(new Error("should not be called")),
					externalPackages: ["not-installed-anywhere"],
				},
			);
			const inputs = Object.keys(metafile?.inputs ?? {});
			expect(inputs.some((i) => i.endsWith("helper.ts"))).toBe(true);
		});
	});

	test("packaged mode uses the binary and never imports the esbuild module", async () => {
		const loadEsbuild = vi.fn(() =>
			Promise.reject(new Error("should not be called")),
		);
		await withEnv(ESBUILD_BIN, async () => {
			const out = await bundleEntry(join(dir, "index.ts"), {
				isPackaged: () => true,
				loadEsbuild,
			});
			expect(loadEsbuild).not.toHaveBeenCalled();
			expect(strFromU8(out.files["index.mjs"])).toContain(
				"hi from helper",
			);
		});
	});

	test("falls back to the binary when the esbuild module cannot be imported", async () => {
		const loadEsbuild = vi.fn(() =>
			Promise.reject(new Error("Cannot find module esbuild")),
		);
		await withEnv(ESBUILD_BIN, async () => {
			const out = await bundleEntry(join(dir, "index.ts"), {
				isPackaged: () => false,
				loadEsbuild,
			});
			expect(loadEsbuild).toHaveBeenCalledOnce();
			expect(strFromU8(out.files["index.mjs"])).toContain(
				"hi from helper",
			);
		});
	});

	test("names the bad NEON_ESBUILD_PATH rather than reporting esbuild missing", async () => {
		// Telling someone who set the variable to "set NEON_ESBUILD_PATH" is not
		// a usable error; the value they set is the thing that is wrong.
		const loadEsbuild = vi.fn(() =>
			Promise.reject(new Error("should not be called")),
		);
		const bogus = join(dir, "no-such-esbuild");
		await withEnv(bogus, async () => {
			await expect(
				bundleEntry(join(dir, "index.ts"), {
					isPackaged: () => true,
					loadEsbuild,
				}),
			).rejects.toThrow(`NEON_ESBUILD_PATH is set to ${bogus}`);
		});
	});
});
