import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";

const dir = dirname(fileURLToPath(import.meta.url));

test("function commands do not import config-runtime's esbuild bundler", () => {
	for (const name of ["functions.ts", "config.ts", "dev.ts"]) {
		const text = readFileSync(join(dir, name), "utf8");
		expect(text, name).not.toMatch(/buildFunctionBundle/);
		expect(text, name).not.toMatch(/function-bundle/);
	}
});
