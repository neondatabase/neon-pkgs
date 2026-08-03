import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	inspectDist,
	isTestArtifact,
	isVendored,
	packageOf,
	segmentsOf,
	vendoredPackageOf,
} from "./dist-guard.mjs";

describe("path classification", () => {
	it("splits on the platform separator so Windows paths behave the same", () => {
		expect(segmentsOf("dist/neon/client.js")).toEqual([
			"dist",
			"neon",
			"client.js",
		]);
	});

	it("recognises a vendored file", () => {
		expect(isVendored("dist/node_modules/chai/chai.js")).toBe(true);
		expect(isVendored("dist/neon/client.js")).toBe(false);
		// A source file merely named after the directory is not vendored.
		expect(isVendored("dist/neon/node_modules-helper.js")).toBe(false);
	});

	it("names the real package behind pnpm's nested layout", () => {
		expect(
			vendoredPackageOf(
				"dist/node_modules/.pnpm/chai@5.2.0/node_modules/chai/lib/chai.js",
			),
		).toBe("chai");
		expect(
			vendoredPackageOf(
				"dist/node_modules/.pnpm/@vitest_utils@3.0.9/node_modules/@vitest/utils/dist/index.js",
			),
		).toBe("@vitest/utils");
	});

	it("keeps a scope together and drops the subpath", () => {
		expect(packageOf("@scope/pkg/deep/path")).toBe("@scope/pkg");
		expect(packageOf("chai")).toBe("chai");
	});

	it("catches both test-file spellings, which is the bug that shipped", () => {
		expect(isTestArtifact("dist/neon/client.test-d.js")).toBe(true);
		expect(isTestArtifact("dist/neon/errors.test.js")).toBe(true);
		expect(isTestArtifact("dist/neon/client.js")).toBe(false);
		// `latest.js` contains "test" but is not a test artifact.
		expect(isTestArtifact("dist/neon/latest.js")).toBe(false);
	});
});

describe("inspectDist against a real package tree", () => {
	const roots = [];

	afterEach(async () => {
		await Promise.all(roots.map((root) => rm(root, { recursive: true })));
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

	it("passes a clean dist", async () => {
		const root = await packageRoot({
			files: { "dist/index.js": "export const a = 1;\n" },
		});
		const { problems, fileCount } = await inspectDist(root);
		expect(problems).toEqual([]);
		expect(fileCount).toBe(1);
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
		expect(problems[0]).toContain("dist/node_modules/");
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

	it("fails on a runtime dependency, which is also what would be left external", async () => {
		const root = await packageRoot({
			manifest: { dependencies: { undici: "^6.0.0" } },
			files: { "dist/index.js": "export const a = 1;\n" },
		});
		const { problems } = await inspectDist(root);
		expect(problems).toHaveLength(1);
		expect(problems[0]).toContain("undici");
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

	it("fails when dist is empty, so a missing build cannot look like a pass", async () => {
		const root = await packageRoot({ files: { "dist/.keep": "" } });
		await rm(join(root, "dist/.keep"));
		const { problems } = await inspectDist(root);
		expect(problems.some((p) => p.includes("dist/ is empty"))).toBe(true);
	});
});
