import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ResolvedFunctionConfig } from "@neon/config";
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

function fn(
	source: string,
	externalPackages?: string[],
): ResolvedFunctionConfig {
	return {
		slug: "fn1",
		name: "Hello World",
		source,
		env: {},
		runtime: "nodejs24",
		...(externalPackages
			? {
					externalPackages: externalPackages.map((name) => ({
						name,
						includeFiles: true,
					})),
				}
			: {}),
	};
}

describe("buildFunctionBundle", () => {
	test("bundles a handler with esbuild and returns a ZIP containing index.mjs (no sourcemap)", async () => {
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
		// No source map is generated — the Functions runtime never consumes it, so shipping
		// one only inflated the archive.
		expect(names).not.toContain("index.mjs.map");

		// The bundled output should have inlined the imported constant.
		const js = new TextDecoder().decode(files["index.mjs"]);
		expect(js).toContain("hello from neon");
		// And it must not carry a dangling source-map link to a file we no longer ship.
		expect(js).not.toContain("sourceMappingURL");
		// The ESM↔CJS interop banner is prepended so bundled CommonJS deps can `require(...)`.
		expect(js).toContain("createRequire");
	});

	test("throws a PlatformError when the source cannot be resolved", async () => {
		await expect(
			buildFunctionBundle(fn(join(dir, "does-not-exist.ts"))),
		).rejects.toThrow(/Failed to bundle function "fn1"/);
	});

	test("fails to bundle an unresolvable dependency when it is not declared external", async () => {
		const source = join(dir, "needs-external.ts");
		writeFileSync(
			source,
			[
				"import { thing } from 'not-installed-anywhere';",
				"export default { fetch(): Response { return new Response(String(thing)); } };",
			].join("\n"),
		);

		// The baseline for the test below: without `externalPackages` this is exactly the
		// deploy-time failure the option exists to fix.
		await expect(buildFunctionBundle(fn(source))).rejects.toThrow(
			/Could not resolve "not-installed-anywhere"/,
		);
	});

	test("leaves a declared external package unbundled instead of failing to resolve it", async () => {
		const source = join(dir, "needs-external.ts");

		const bundle = await buildFunctionBundle(
			fn(source, ["not-installed-anywhere"]),
		);

		const files = unzipSync(bundle);
		const js = new TextDecoder().decode(files["index.mjs"]);
		// The import survives into the output rather than being followed and inlined.
		expect(js).toContain("not-installed-anywhere");
	});

	test("bundles everything not named in externalPackages", async () => {
		const helper = join(dir, "still-bundled.ts");
		writeFileSync(helper, "export const marker = 'inlined by esbuild';\n");
		const source = join(dir, "mixed-externals.ts");
		writeFileSync(
			source,
			[
				"import { marker } from './still-bundled.js';",
				"import { thing } from 'not-installed-anywhere';",
				"export default { fetch(): Response { return new Response(marker + thing); } };",
			].join("\n"),
		);

		const bundle = await buildFunctionBundle(
			fn(source, ["not-installed-anywhere"]),
		);

		const js = new TextDecoder().decode(unzipSync(bundle)["index.mjs"]);
		expect(js).toContain("inlined by esbuild");
		expect(js).toContain("not-installed-anywhere");
	});
});
