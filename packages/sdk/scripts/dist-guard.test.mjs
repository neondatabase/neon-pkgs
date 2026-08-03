import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { init } from "es-module-lexer";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
	externalImportsOf,
	inspectDist,
	isTestArtifact,
	isVendored,
	packageOf,
	segmentsOf,
	vendoredPackageOf,
} from "./dist-guard.mjs";

beforeAll(async () => {
	await init;
});

describe("path classification", () => {
	it("treats both separators as one, so Windows paths classify the same", () => {
		expect(segmentsOf("dist/neon/client.js")).toEqual([
			"dist",
			"neon",
			"client.js",
		]);
		expect(segmentsOf("dist\\neon\\client.js")).toEqual([
			"dist",
			"neon",
			"client.js",
		]);
	});

	it("recognises a vendored file given Windows separators", () => {
		// `path.relative` returns backslashes on Windows. Splitting on "/" alone matched
		// nothing there, so the guard passed a dist/ full of vendored packages.
		expect(isVendored("dist\\node_modules\\chai\\chai.js")).toBe(true);
		expect(isVendored("dist/node_modules/chai/chai.js")).toBe(true);
		expect(isVendored("dist/neon/client.js")).toBe(false);
		expect(isVendored("dist/neon/node_modules-helper.js")).toBe(false);
	});

	it("names the real package behind pnpm's nested layout, on either separator", () => {
		expect(
			vendoredPackageOf(
				"dist/node_modules/.pnpm/chai@5.2.0/node_modules/chai/lib/chai.js",
			),
		).toBe("chai");
		expect(
			vendoredPackageOf(
				"dist\\node_modules\\.pnpm\\chai@5.2.0\\node_modules\\chai\\lib\\chai.js",
			),
		).toBe("chai");
		expect(
			vendoredPackageOf(
				"dist/node_modules/.pnpm/@vitest_utils@3.0.9/node_modules/@vitest/utils/dist/index.js",
			),
		).toBe("@vitest/utils");
	});

	it("keeps a scope together, drops the subpath, and survives an empty specifier", () => {
		expect(packageOf("@scope/pkg/deep/path")).toBe("@scope/pkg");
		expect(packageOf("chai")).toBe("chai");
		expect(packageOf("")).toBe("");
	});

	it("catches both test-file spellings, which is the bug that shipped", () => {
		expect(isTestArtifact("dist/neon/client.test-d.js")).toBe(true);
		expect(isTestArtifact("dist/neon/errors.test.js")).toBe(true);
		expect(isTestArtifact("dist/neon/client.js")).toBe(false);
		expect(isTestArtifact("dist/neon/latest.js")).toBe(false);
	});
});

describe("externalImportsOf", () => {
	it("finds bare imports and ignores relative and builtin ones", () => {
		const source = [
			'import { readFile } from "node:fs/promises";',
			'import { local } from "./local.js";',
			'import { dep } from "undici";',
			'export * from "@scope/pkg/sub";',
		].join("\n");
		expect([...externalImportsOf(source)].sort()).toEqual([
			"@scope/pkg/sub",
			"undici",
		]);
	});

	it("finds an import split across lines, which the old regex missed", () => {
		const source = 'import {\n  a,\n  b,\n} from\n  "undici";\n';
		expect([...externalImportsOf(source)]).toEqual(["undici"]);
	});

	it("ignores import-like text in comments and strings, which the old regex flagged", () => {
		// This is not hypothetical: the first version of this guard rejected the package
		// because its JSDoc @example blocks import @neon/sdk.
		const source = [
			"/**",
			" * @example",
			' * import { createNeonClient } from "@neon/sdk";',
			" */",
			'const docs = \'import { x } from "chai"\';',
			'// import { y } from "vitest";',
			"export const a = docs;",
		].join("\n");
		expect([...externalImportsOf(source)]).toEqual([]);
	});

	it("finds a literal dynamic import", () => {
		expect([...externalImportsOf('await import("undici");')]).toEqual([
			"undici",
		]);
	});

	it("skips a dynamic import nothing could resolve statically", () => {
		expect([...externalImportsOf("await import(specifier);")]).toEqual([]);
	});
});

describe("inspectDist against a real package tree", () => {
	const roots = [];

	afterEach(async () => {
		// Runs even when a test fails, so a failure cannot leave temp trees behind.
		await Promise.all(
			roots.map((root) => rm(root, { recursive: true, force: true })),
		);
		roots.length = 0;
	});

	/** Build a throwaway package root on disk; no mocks, real files. */
	async function packageRoot({ manifest = {}, files = {} }) {
		const root = await mkdtemp(join(tmpdir(), "dist-guard-"));
		roots.push(root);
		await writeFile(
			join(root, "package.json"),
			JSON.stringify({ name: "@neon/sdk", ...manifest }),
		);
		for (const [path, contents] of Object.entries(files)) {
			const full = join(root, path);
			await mkdir(join(full, ".."), { recursive: true });
			await writeFile(full, contents);
		}
		return root;
	}

	it("passes a clean dist, including one whose comments mention imports", async () => {
		const root = await packageRoot({
			files: {
				"dist/index.js": [
					"/** @example import { createNeonClient } from \"@neon/sdk\"; */",
					'import { readFile } from "node:fs/promises";',
					'import { local } from "./local.js";',
					"export { readFile, local };",
				].join("\n"),
				"dist/local.js": "export const local = 1;\n",
			},
		});
		const { problems, fileCount } = await inspectDist(root);
		expect(problems).toEqual([]);
		expect(fileCount).toBe(2);
	});

	it("fails on a bundled dependency and names it", async () => {
		const root = await packageRoot({
			files: {
				"dist/index.js": "export const a = 1;\n",
				"dist/node_modules/.pnpm/chai@5.2.0/node_modules/chai/chai.js":
					"module.exports = {};\n",
			},
		});
		const { problems } = await inspectDist(root);
		expect(problems).toHaveLength(1);
		expect(problems[0]).toContain("chai");
	});

	it("fails on an emitted type-test artifact", async () => {
		const root = await packageRoot({
			files: {
				"dist/index.js": "export const a = 1;\n",
				"dist/neon/client.test-d.js": "export const t = 1;\n",
			},
		});
		const { problems } = await inspectDist(root);
		expect(problems).toHaveLength(1);
		expect(problems[0]).toContain("client.test-d.js");
	});

	it("fails on a declared runtime dependency in any of the three fields", async () => {
		for (const field of [
			"dependencies",
			"peerDependencies",
			"optionalDependencies",
		]) {
			const root = await packageRoot({
				manifest: { [field]: { undici: "^6.0.0" } },
				files: { "dist/index.js": "export const a = 1;\n" },
			});
			const { problems } = await inspectDist(root);
			expect(problems).toHaveLength(1);
			expect(problems[0]).toContain(field);
			expect(problems[0]).toContain("undici");
		}
	});

	it("fails on a peer dependency left as a bare import, which manifest checks alone missed", async () => {
		// tsdown externalizes dependencies AND peerDependencies, so this combination
		// emits an import the consumer must install. Checking `dependencies` alone
		// reported this tree as clean.
		const root = await packageRoot({
			manifest: { peerDependencies: { undici: "^6.0.0" } },
			files: { "dist/index.js": 'import "undici";\nexport const a = 1;\n' },
		});
		const { problems } = await inspectDist(root);
		expect(problems).toHaveLength(2);
		expect(problems.some((p) => p.includes("peerDependencies"))).toBe(true);
		expect(problems.some((p) => p.includes("at runtime"))).toBe(true);
	});

	it("fails on a bare import no manifest field records, as an `external` option would produce", async () => {
		const root = await packageRoot({
			files: { "dist/index.js": 'import { x } from "undici";\nexport { x };\n' },
		});
		const { problems } = await inspectDist(root);
		expect(problems).toHaveLength(1);
		expect(problems[0]).toContain("undici");
		expect(problems[0]).toContain("external");
	});

	it("reports every problem at once rather than stopping at the first", async () => {
		const root = await packageRoot({
			manifest: { dependencies: { undici: "^6.0.0" } },
			files: {
				"dist/neon/client.test-d.js": "export const t = 1;\n",
				"dist/node_modules/chai/chai.js": "module.exports = {};\n",
			},
		});
		const { problems } = await inspectDist(root);
		expect(problems).toHaveLength(3);
	});

	it("reports a missing dist rather than throwing ENOENT", async () => {
		const root = await packageRoot({ files: {} });
		const { problems } = await inspectDist(root);
		expect(problems).toHaveLength(1);
		expect(problems[0]).toContain("missing or empty");
	});

	it("reports an empty dist directory the same way", async () => {
		const root = await packageRoot({ files: { "dist/.keep": "" } });
		await rm(join(root, "dist/.keep"));
		const { problems } = await inspectDist(root);
		expect(problems.some((p) => p.includes("missing or empty"))).toBe(true);
	});
});
