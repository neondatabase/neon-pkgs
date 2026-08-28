import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { ResolvedFunctionConfig } from "@neon/config";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { bundleAsIs, resolveEsbuildEntry } from "./function-source.js";

let root: string;
beforeAll(() => {
	root = mkdtempSync(join(tmpdir(), "neon-fn-source-"));
});
afterAll(() => {
	rmSync(root, { recursive: true, force: true });
});

const buildDir = (files: Record<string, string>): string => {
	const outDir = join(root, `out-${Math.random().toString(36).slice(2)}`);
	for (const [rel, contents] of Object.entries(files)) {
		const abs = join(outDir, rel);
		mkdirSync(join(abs, ".."), { recursive: true });
		writeFileSync(abs, contents);
	}
	return outDir;
};

const noneFn = (source: string): ResolvedFunctionConfig => ({
	slug: "fn1",
	name: "Hello World",
	source,
	env: {},
	runtime: "nodejs24",
	bundler: "none",
});

describe("resolveEsbuildEntry", () => {
	test("returns a file source unchanged", async () => {
		const file = join(root, "custom.ts");
		writeFileSync(file, "export default {};\n");
		await expect(resolveEsbuildEntry(file)).resolves.toBe(file);
	});

	test("discovers index.ts over index.js over index.mjs", async () => {
		const dir = buildDir({
			"index.ts": "export default { ts: true };\n",
			"index.js": "export default { js: true };\n",
			"index.mjs": "export default { mjs: true };\n",
		});
		await expect(resolveEsbuildEntry(dir)).resolves.toBe(
			join(dir, "index.ts"),
		);
	});

	test("discovers index.js over index.mjs when no index.ts", async () => {
		const dir = buildDir({
			"index.js": "export default { js: true };\n",
			"index.mjs": "export default { mjs: true };\n",
		});
		await expect(resolveEsbuildEntry(dir)).resolves.toBe(
			join(dir, "index.js"),
		);
	});

	test("discovers index.mjs when it is the only source entry", async () => {
		const dir = buildDir({
			"index.mjs": "export default { mjs: true };\n",
		});
		await expect(resolveEsbuildEntry(dir)).resolves.toBe(
			join(dir, "index.mjs"),
		);
	});

	test("does not treat a directory named index.ts as the entry", async () => {
		const dir = buildDir({
			"index.js": "export default { js: true };\n",
		});
		mkdirSync(join(dir, "index.ts"));
		await expect(resolveEsbuildEntry(dir)).resolves.toBe(
			join(dir, "index.js"),
		);
	});

	test("rejects a directory with no source entry file", async () => {
		const dir = buildDir({ "handler.ts": "export default {};\n" });
		await expect(resolveEsbuildEntry(dir)).rejects.toThrow(
			/Expected one of: index\.ts, index\.js, index\.mjs/,
		);
	});

	test("rejects a missing path", async () => {
		await expect(
			resolveEsbuildEntry(join(root, "does-not-exist")),
		).rejects.toThrow(/does not exist/);
	});
});

describe("bundleAsIs", () => {
	test("ships every file in the directory, preserving nested structure", async () => {
		const source = buildDir({
			"index.mjs": "export default { fetch: () => new Response('ok') };",
			"chunk-abc.mjs": "export const x = 1;",
			"studio/index.html": "<!doctype html><title>Studio</title>",
			"studio/assets/app.js": "console.log('studio');",
		});

		const bundle = await bundleAsIs(noneFn(source));

		expect(Object.keys(bundle).sort()).toEqual([
			"chunk-abc.mjs",
			"index.mjs",
			"studio/assets/app.js",
			"studio/index.html",
		]);
		expect(new TextDecoder().decode(bundle["studio/assets/app.js"])).toBe(
			"console.log('studio');",
		);
	});

	test("ships a directory that has both index.ts and index.js", async () => {
		const source = buildDir({
			"index.ts": "export default {};\n",
			"index.js":
				"export default { fetch() { return new Response('ok'); } };\n",
		});
		const bundle = await bundleAsIs(noneFn(source));
		expect(Object.keys(bundle).sort()).toEqual(["index.js", "index.ts"]);
	});

	test("zips a single index.mjs file", async () => {
		const file = join(root, "index.mjs");
		writeFileSync(file, "export default {};\n");
		const bundle = await bundleAsIs(noneFn(file));
		expect(Object.keys(bundle)).toEqual(["index.mjs"]);
	});

	test("zips a single index.js file", async () => {
		const file = join(
			buildDir({ "index.js": "export default {};\n" }),
			"index.js",
		);
		const bundle = await bundleAsIs(noneFn(file));
		expect(Object.keys(bundle)).toEqual(["index.js"]);
	});

	test("rejects a directory with no archive entry at its root", async () => {
		const source = buildDir({
			"server/index.mjs": "export default {};",
		});
		await expect(bundleAsIs(noneFn(source))).rejects.toThrow(
			/no entry module at its root/,
		);
	});

	test("rejects a directory that only has index.ts", async () => {
		const source = buildDir({
			"index.ts": "export default {};\n",
		});
		await expect(bundleAsIs(noneFn(source))).rejects.toThrow(
			/bundler is "none".*TypeScript/,
		);
	});

	test("rejects a file named index.ts", async () => {
		const file = join(root, "index.ts");
		writeFileSync(file, "export default {};\n");
		await expect(bundleAsIs(noneFn(file))).rejects.toThrow(
			/bundler is "none".*TypeScript/,
		);
	});

	test("rejects a file not named index.mjs or index.js", async () => {
		const file = join(root, "handler.mjs");
		writeFileSync(file, "export default {};\n");
		await expect(bundleAsIs(noneFn(file))).rejects.toThrow(
			new RegExp(`named "${basename(file)}"`),
		);
	});

	test("uses the --no-bundle wording when via is no-bundle", async () => {
		const file = join(root, "index.ts");
		writeFileSync(file, "export default {};\n");
		await expect(
			bundleAsIs(noneFn(file), { via: "no-bundle" }),
		).rejects.toThrow(/omit --no-bundle/);
	});

	test("rejects a source that does not exist", async () => {
		await expect(
			bundleAsIs(noneFn(join(root, "does-not-exist"))),
		).rejects.toThrow(/does not exist/);
	});
});
