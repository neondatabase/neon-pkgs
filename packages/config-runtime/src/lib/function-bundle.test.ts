import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ResolvedFunctionConfig } from "@neondatabase/config";
import { unzipSync } from "fflate";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { buildFunctionBundle } from "./function-bundle.js";

let dir: string;
beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), "neon-bundle-"));
});
afterAll(() => {
	rmSync(dir, { recursive: true, force: true });
});

function fn(source: string): ResolvedFunctionConfig {
	return {
		slug: "fn1",
		name: "Hello World",
		source,
		env: {},
		runtime: "nodejs24",
	};
}

describe("buildFunctionBundle", () => {
	test("bundles a handler with esbuild and returns a ZIP containing index.mjs + sourcemap", async () => {
		const helper = join(dir, "shared.ts");
		writeFileSync(helper, "export const greeting = 'hello from neon';\n");
		const source = join(dir, "hello-world.ts");
		// Importing a sibling proves esbuild actually *bundles* (not just copies) the entry.
		writeFileSync(
			source,
			[
				"import { greeting } from './shared.js';",
				"export default { fetch(_req: Request): Response { return new Response(greeting); } };",
			].join("\n"),
		);

		const bundle = await buildFunctionBundle(fn(source));
		expect(bundle.byteLength).toBeGreaterThan(0);

		const files = unzipSync(bundle);
		const names = Object.keys(files).sort();
		expect(names).toContain("index.mjs");
		expect(names).toContain("index.mjs.map");

		// The bundled output should have inlined the imported constant.
		const js = new TextDecoder().decode(files["index.mjs"]);
		expect(js).toContain("hello from neon");
	});

	test("throws a PlatformError when the source cannot be resolved", async () => {
		await expect(
			buildFunctionBundle(fn(join(dir, "does-not-exist.ts"))),
		).rejects.toThrow(/Failed to bundle function "fn1"/);
	});
});
