import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const dir = dirname(fileURLToPath(import.meta.url));
const srcRoot = join(dir, "..");

const walkTs = (root: string): string[] => {
	const out: string[] = [];
	for (const ent of readdirSync(root, { withFileTypes: true })) {
		const path = join(root, ent.name);
		if (ent.isDirectory()) {
			if (ent.name === "node_modules") continue;
			out.push(...walkTs(path));
			continue;
		}
		if (ent.name.endsWith(".ts") && !ent.name.includes(".test.")) {
			out.push(path);
		}
	}
	return out;
};

const stripComments = (text: string): string =>
	text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

const LITERAL_ESBUILD =
	/\bfrom\s+["']esbuild["']|\bimport\s*\(\s*["']esbuild["']\s*\)|\brequire\s*\(\s*["']esbuild["']\s*\)/;

test("function commands do not import config-runtime's esbuild bundler", () => {
	for (const name of ["functions.ts", "config.ts", "dev.ts"]) {
		const text = readFileSync(join(dir, name), "utf8");
		expect(text, name).not.toMatch(/buildFunctionBundle/);
		expect(text, name).not.toMatch(/function-bundle/);
	}
});

test("no CLI source file loads esbuild with a literal module specifier", () => {
	const hits: string[] = [];
	for (const file of walkTs(srcRoot)) {
		if (LITERAL_ESBUILD.test(stripComments(readFileSync(file, "utf8")))) {
			hits.push(file.slice(srcRoot.length + 1));
		}
	}
	expect(hits).toEqual([]);
});

test("CLI esbuild loaders keep a computed specifier", () => {
	for (const rel of ["utils/esbuild.ts", "dev/inputs.ts"]) {
		expect(readFileSync(join(srcRoot, rel), "utf8"), rel).toContain(
			'["es", "build"].join("")',
		);
	}
});
