import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const srcRoot = dirname(fileURLToPath(import.meta.url));

const walkTs = (dir: string): string[] => {
	const out: string[] = [];
	for (const ent of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, ent.name);
		if (ent.isDirectory()) {
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

test("no source file loads esbuild with a literal module specifier", () => {
	const hits: string[] = [];
	for (const file of walkTs(srcRoot)) {
		if (LITERAL_ESBUILD.test(stripComments(readFileSync(file, "utf8")))) {
			hits.push(file.slice(srcRoot.length + 1));
		}
	}
	expect(hits).toEqual([]);
});

test("loadEsbuild keeps a computed specifier", () => {
	const text = readFileSync(join(srcRoot, "lib/function-bundle.ts"), "utf8");
	expect(text).toContain('["es", "build"].join("")');
});
