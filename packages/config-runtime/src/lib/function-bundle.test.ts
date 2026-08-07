import { createHash, randomFillSync } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	ResolvedExternalPackage,
	ResolvedFunctionConfig,
} from "@neon/config";
import { unzipSync, zipSync } from "fflate";
import {
	afterAll,
	beforeAll,
	beforeEach,
	describe,
	expect,
	test,
} from "vitest";
import { buildFunctionBundle } from "./function-bundle.js";
import type { NativeTraceDeps } from "./native-packages.js";

let dir: string;
beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), "neon-bundle-"));
});
afterAll(() => {
	rmSync(dir, { recursive: true, force: true });
});

function fn(
	source: string,
	externalPackages?: (string | ResolvedExternalPackage)[],
): ResolvedFunctionConfig {
	return {
		slug: "fn1",
		name: "Hello World",
		source,
		env: {},
		runtime: "nodejs24",
		...(externalPackages
			? {
					externalPackages: externalPackages.map((entry) =>
						typeof entry === "string"
							? { name: entry, includeFiles: true }
							: entry,
					),
				}
			: {}),
	};
}

/** An entry that is externalized but stages nothing — the `includeFiles: false` escape. */
const excluded = (name: string): ResolvedExternalPackage => ({
	name,
	includeFiles: false,
});

/**
 * Warnings are advisory and go to a callback rather than a return value, so a test that does
 * not pass one lets them reach `console.warn` — which `console-fail-test` turns into a
 * failure. Collecting them keeps the default honest and makes them assertable.
 */
let warnings: string[] = [];
const collectWarning = (message: string): void => {
	warnings.push(message);
};
beforeEach(() => {
	warnings = [];
});

const sha256 = (data: Uint8Array): string =>
	createHash("sha256").update(data).digest("hex");

/** A 20-byte ELF header claiming the given `e_machine`, padded to a plausible file. */
function elfHeader(machine: number): Uint8Array {
	const buf = Buffer.alloc(64);
	buf.write("\x7fELF", 0, "binary");
	buf[4] = 2; // 64-bit
	buf[5] = 1; // little-endian
	buf.writeUInt16LE(machine, 18);
	return new Uint8Array(buf);
}

const AARCH64 = 0xb7;
const X86_64 = 0x3e;

/**
 * Stand-ins for the registry and the tracer, so the bundler's own logic is exercised without
 * a network install. `files` is written into the staging directory the way npm would, and
 * every path is then reported as traced.
 */
function fakeNativeDeps(files: Record<string, Uint8Array>): NativeTraceDeps {
	return {
		install: async (cwd) => {
			for (const [relative, contents] of Object.entries(files)) {
				const absolute = join(cwd, relative);
				mkdirSync(join(absolute, ".."), { recursive: true });
				writeFileSync(absolute, contents);
			}
		},
		trace: async () => Object.keys(files),
		installedVersion: () => undefined,
	};
}

const pkgJson = (name: string): Uint8Array =>
	new TextEncoder().encode(JSON.stringify({ name, version: "1.0.0" }));

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

		// `includeFiles: false`, because this package does not exist anywhere — the point
		// here is only that esbuild stops following the import.
		const bundle = await buildFunctionBundle(
			fn(source, [excluded("not-installed-anywhere")]),
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
			fn(source, [excluded("not-installed-anywhere")]),
		);

		const js = new TextDecoder().decode(unzipSync(bundle)["index.mjs"]);
		expect(js).toContain("inlined by esbuild");
		expect(js).toContain("not-installed-anywhere");
	});

	// The flip that this change is about: a bare string means "ship this package's files",
	// so a name that resolves nowhere fails at deploy rather than silently shipping an
	// archive whose import cannot resolve at invoke.
	test("a bare entry stages the package, so an unresolvable name fails the deploy", async () => {
		const source = join(dir, "needs-external.ts");

		await expect(
			buildFunctionBundle(fn(source, ["not-installed-anywhere"]), {
				nativeDeps: {
					install: async () => {
						throw new Error("E404 not found");
					},
				},
			}),
		).rejects.toThrow(/E404 not found/);
	});
});

describe("buildFunctionBundle staging external package files", () => {
	// The guarantee that lets this ship: a policy that says nothing about native packages
	// gets the archive it always did, to the byte. Written against the bytes the pre-existing
	// code path produces (esbuild output, zipped at level 6, one entry keyed by basename)
	// rather than a recorded constant, so it stays honest if esbuild's output changes.
	test("produces a byte-identical archive to the pre-existing path when undeclared", async () => {
		const source = join(dir, "plain.ts");
		writeFileSync(
			source,
			"export default { fetch(): Response { return new Response('plain'); } };",
		);

		const bundle = await buildFunctionBundle(fn(source));
		const entries = unzipSync(bundle);
		expect(Object.keys(entries)).toEqual(["index.mjs"]);

		const expected = zipSync(
			{ "index.mjs": entries["index.mjs"] },
			{ level: 6 },
		);
		expect(sha256(bundle)).toBe(sha256(expected));
	});

	test("does not install or trace anything when the list is absent", async () => {
		const source = join(dir, "plain.ts");
		let installed = false;
		let traced = false;

		await buildFunctionBundle(fn(source), {
			nativeDeps: {
				install: async () => {
					installed = true;
				},
				trace: async () => {
					traced = true;
					return [];
				},
			},
		});

		expect(installed).toBe(false);
		expect(traced).toBe(false);
	});

	// The escape hatch has to be genuinely free: an entry that opts out must take the same
	// path as no entry at all, or `includeFiles: false` would still cost an install.
	test("installs and traces nothing when every entry sets includeFiles: false", async () => {
		const source = join(dir, "opted-out.ts");
		writeFileSync(
			source,
			[
				"import addon from 'fake-addon';",
				"export default { fetch(): Response { return new Response(String(addon)); } };",
			].join("\n"),
		);
		let installed = false;
		let traced = false;

		const bundle = await buildFunctionBundle(
			fn(source, [excluded("fake-addon")]),
			{
				nativeDeps: {
					install: async () => {
						installed = true;
					},
					trace: async () => {
						traced = true;
						return [];
					},
				},
			},
		);

		expect(installed).toBe(false);
		expect(traced).toBe(false);
		// The import survives into the bundle unresolved, and nothing ships beside it.
		expect(Object.keys(unzipSync(bundle))).toEqual(["index.mjs"]);
	});

	// Staging the registry's latest instead of the version the user tested is exactly the
	// kind of difference that shows up as an unreproducible production bug, so it is said
	// out loud rather than left to be discovered from a deployed archive.
	test("warns when a staged package's version cannot be read from the project", async () => {
		const source = join(dir, "uses-native.ts");
		writeFileSync(
			source,
			[
				"import addon from 'fake-addon';",
				"export default { fetch(): Response { return new Response(String(addon)); } };",
			].join("\n"),
		);

		await buildFunctionBundle(fn(source, ["fake-addon"]), {
			onWarning: collectWarning,
			nativeDeps: fakeNativeDeps({
				"node_modules/fake-addon/package.json": pkgJson("fake-addon"),
				"node_modules/fake-addon/index.js": new TextEncoder().encode(
					"module.exports = 1;",
				),
			}),
		});

		expect(
			warnings.some(
				(w) =>
					w.includes("fake-addon") &&
					w.includes("registry resolves as latest"),
			),
		).toBe(true);
	});

	test("ships the traced files under their node_modules paths, unflattened", async () => {
		const source = join(dir, "uses-native.ts");
		writeFileSync(
			source,
			[
				"import addon from 'fake-addon';",
				"export default { fetch(): Response { return new Response(String(addon)); } };",
			].join("\n"),
		);

		const bundle = await buildFunctionBundle(fn(source, ["fake-addon"]), {
			onWarning: collectWarning,
			nativeDeps: fakeNativeDeps({
				"node_modules/fake-addon/package.json": pkgJson("fake-addon"),
				"node_modules/fake-addon/index.js": new TextEncoder().encode(
					"module.exports = 1;",
				),
				"node_modules/@scope/fake-addon-linux-arm64/lib/addon.node":
					elfHeader(AARCH64),
				"node_modules/@scope/fake-addon-libs/lib/libthing.so.1":
					elfHeader(AARCH64),
			}),
		});

		const names = Object.keys(unzipSync(bundle)).sort();
		// The nested paths are what a `.node` addon needs: it locates its sibling shared
		// libraries relative to its own directory, so a flat archive would break loading even
		// with every file present.
		expect(names).toEqual([
			"index.mjs",
			"node_modules/@scope/fake-addon-libs/lib/libthing.so.1",
			"node_modules/@scope/fake-addon-linux-arm64/lib/addon.node",
			"node_modules/fake-addon/index.js",
			"node_modules/fake-addon/package.json",
		]);
		// Nothing collapsed to a basename.
		expect(names).not.toContain("addon.node");
		expect(names).not.toContain("package.json");
	});

	test("leaves the declared package's import in the bundle instead of inlining it", async () => {
		const source = join(dir, "uses-native.ts");

		const bundle = await buildFunctionBundle(fn(source, ["fake-addon"]), {
			onWarning: collectWarning,
			nativeDeps: fakeNativeDeps({
				"node_modules/fake-addon/package.json": pkgJson("fake-addon"),
			}),
		});

		const js = new TextDecoder().decode(unzipSync(bundle)["index.mjs"]);
		// The import survives and now resolves, because the files are in the archive beside it.
		expect(js).toContain("fake-addon");
	});

	test("still inlines everything not named in the list", async () => {
		const helper = join(dir, "native-helper.ts");
		writeFileSync(helper, "export const marker = 'still inlined';\n");
		const source = join(dir, "native-plus-local.ts");
		writeFileSync(
			source,
			[
				"import { marker } from './native-helper.js';",
				"import addon from 'fake-addon';",
				"export default { fetch(): Response { return new Response(marker + addon); } };",
			].join("\n"),
		);

		const bundle = await buildFunctionBundle(fn(source, ["fake-addon"]), {
			onWarning: collectWarning,
			nativeDeps: fakeNativeDeps({
				"node_modules/fake-addon/package.json": pkgJson("fake-addon"),
			}),
		});

		const js = new TextDecoder().decode(unzipSync(bundle)["index.mjs"]);
		expect(js).toContain("still inlined");
		expect(js).toContain("fake-addon");
	});

	test("fails when a declared package produced no build for the runtime target", async () => {
		const source = join(dir, "uses-native.ts");

		// npm omits a platform-specific optional dependency silently when none matches, so an
		// install can "succeed" and leave the package absent.
		await expect(
			buildFunctionBundle(fn(source, ["fake-addon"]), {
				onWarning: collectWarning,
				nativeDeps: fakeNativeDeps({}),
			}),
		).rejects.toThrow(
			/did not install for the Functions runtime \(linux-arm64/,
		);
	});

	test("rejects a binary built for the wrong architecture", async () => {
		const source = join(dir, "uses-native.ts");

		await expect(
			buildFunctionBundle(fn(source, ["fake-addon"]), {
				onWarning: collectWarning,
				nativeDeps: fakeNativeDeps({
					"node_modules/fake-addon/package.json":
						pkgJson("fake-addon"),
					"node_modules/fake-addon/lib/addon.node": elfHeader(X86_64),
				}),
			}),
		).rejects.toThrow(
			/built for a different architecture \(ELF machine 0x3e\)/,
		);
	});

	test("rejects a binary that is not a Linux binary at all", async () => {
		const source = join(dir, "uses-native.ts");
		// A Mach-O magic number, i.e. a binary compiled on the user's own macOS machine.
		const machO = new Uint8Array(Buffer.alloc(64));
		Buffer.from(machO.buffer).writeUInt32BE(0xcffaedfe, 0);

		await expect(
			buildFunctionBundle(fn(source, ["fake-addon"]), {
				onWarning: collectWarning,
				nativeDeps: fakeNativeDeps({
					"node_modules/fake-addon/package.json":
						pkgJson("fake-addon"),
					"node_modules/fake-addon/lib/addon.node": machO,
				}),
			}),
		).rejects.toThrow(/is not a Linux binary/);
	});

	// Sibling platform builds that cannot run on the runtime. Dropping the wasm build is not
	// only about size: shipping it would let a broken native path succeed quietly on a slower
	// code path instead of failing loudly.
	test("drops sibling wasm and musl builds from the archive", async () => {
		const source = join(dir, "uses-native.ts");

		const bundle = await buildFunctionBundle(fn(source, ["fake-addon"]), {
			onWarning: collectWarning,
			nativeDeps: fakeNativeDeps({
				"node_modules/fake-addon/package.json": pkgJson("fake-addon"),
				"node_modules/@scope/fake-addon-linux-arm64/lib/addon.node":
					elfHeader(AARCH64),
				"node_modules/@scope/fake-addon-wasm32/lib/addon.node.js":
					new TextEncoder().encode("// wasm fallback"),
				"node_modules/@scope/fake-addon-linuxmusl-arm64/lib/addon.node":
					elfHeader(AARCH64),
			}),
		});

		const names = Object.keys(unzipSync(bundle));
		expect(names).toContain(
			"node_modules/@scope/fake-addon-linux-arm64/lib/addon.node",
		);
		expect(names.filter((n) => n.includes("wasm32"))).toEqual([]);
		expect(names.filter((n) => n.includes("musl"))).toEqual([]);
	});

	test("fails when the archive exceeds the compressed size limit, naming the largest files", async () => {
		const source = join(dir, "uses-native.ts");
		// A real aarch64 header, so the architecture check passes and the size limit is what
		// this test exercises. Random bytes so the ZIP genuinely exceeds the limit rather than
		// compressing back under it.
		const big = new Uint8Array(11 * 1024 * 1024);
		big.set(elfHeader(AARCH64), 0);
		for (let offset = 64; offset < big.length; offset += 65536) {
			randomFillSync(big, offset, Math.min(65536, big.length - offset));
		}

		const message = await buildFunctionBundle(fn(source, ["fake-addon"]), {
			onWarning: collectWarning,
			nativeDeps: fakeNativeDeps({
				"node_modules/fake-addon/package.json": pkgJson("fake-addon"),
				"node_modules/fake-addon/lib/huge.so.1": big,
			}),
		}).then(
			() => "unexpectedly succeeded",
			(e: unknown) => (e as Error).message,
		);

		expect(message).toMatch(/archive is 1[01]\.\d MiB compressed/);
		expect(message).toContain("node_modules/fake-addon/lib/huge.so.1");
	});
});
