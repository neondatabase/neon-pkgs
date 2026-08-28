import { createHash, randomFillSync } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	FunctionBundle,
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
import {
	buildFunctionBundle,
	bundleDirectory,
	ESM_CJS_INTEROP_BANNER,
	resolveFunctionArchive,
} from "./function-bundle.js";
import type { NativeTraceDeps } from "./native-packages.js";

let dir: string;
beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), "neon-bundle-"));
	// Staging pins to the version resolved in the user's project and refuses to guess, so a
	// fixture that stages a package must also be a project that depends on it.
	for (const name of ["fake-addon", "not-installed-anywhere"]) {
		const pkgDir = join(dir, "node_modules", name);
		mkdirSync(pkgDir, { recursive: true });
		writeFileSync(
			join(pkgDir, "package.json"),
			JSON.stringify({ name, version: "1.0.0" }),
		);
	}
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
		bundler: "esbuild",
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
		trace: async () => ({ files: Object.keys(files) }),
		// A resolved version, since staging refuses to guess one. These cases are about what
		// the bundler does with the staged files, not about pinning.
		installedVersion: () => "1.0.0",
	};
}

const pkgJson = (
	name: string,
	platform: Record<string, string[]> = {},
): Uint8Array =>
	new TextEncoder().encode(
		JSON.stringify({ name, version: "1.0.0", ...platform }),
	);

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
	// The guarantee that lets this ship: an undeclared policy gets the archive it always did.
	//
	// Checked against an independently built baseline — esbuild run directly with the
	// pre-existing flags, zipped the way the pre-existing path zipped it. Unzipping the new
	// archive and re-zipping its own bytes would pass no matter what the code did, including
	// if the feature were deleted, so it would assert nothing.
	test("produces a byte-identical archive to the pre-existing path when undeclared", async () => {
		const source = join(dir, "plain.ts");
		writeFileSync(
			source,
			"export default { fetch(): Response { return new Response('plain'); } };",
		);

		const esbuild = await import("esbuild");
		const baseline = await esbuild.build({
			entryPoints: [source],
			bundle: true,
			write: false,
			outfile: "index.mjs",
			minify: true,
			format: "esm",
			platform: "node",
			banner: { js: ESM_CJS_INTEROP_BANNER },
			logLevel: "silent",
		});
		const expected = zipSync(
			{ "index.mjs": baseline.outputFiles[0].contents },
			{ level: 6 },
		);

		const bundle = await buildFunctionBundle(fn(source));
		expect(Object.keys(unzipSync(bundle))).toEqual(["index.mjs"]);
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
					return { files: [] };
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
						return { files: [] };
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
	// Refused rather than guessed: staging the registry's latest would ship code the user has
	// never run, which surfaces as an unreproducible production bug instead of a deploy error.
	test("fails the deploy when a staged package is not installed in the project", async () => {
		const source = join(dir, "uses-native.ts");
		writeFileSync(
			source,
			[
				"import addon from 'fake-addon';",
				"export default { fetch(): Response { return new Response(String(addon)); } };",
			].join("\n"),
		);

		await expect(
			buildFunctionBundle(fn(source, ["fake-addon"]), {
				onWarning: collectWarning,
				nativeDeps: {
					install: async () => {},
					trace: async () => ({ files: [] }),
					installedVersion: () => undefined,
				},
			}),
		).rejects.toThrow(/no installed copy of it could be found/);
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
				// The sibling builds are optional dependencies, which is how a platform-gated
				// package declares them and how the wasm rule knows one is a sibling rather
				// than an ordinary dependency that happens to be named after wasm.
				"node_modules/fake-addon/package.json":
					new TextEncoder().encode(
						JSON.stringify({
							name: "fake-addon",
							version: "1.0.0",
							optionalDependencies: {
								"@scope/fake-addon-linux-arm64": "1.0.0",
								"@scope/fake-addon-wasm32": "1.0.0",
								"@scope/fake-addon-linuxmusl-arm64": "1.0.0",
							},
						}),
					),
				"node_modules/@scope/fake-addon-linux-arm64/package.json":
					pkgJson("@scope/fake-addon-linux-arm64", {
						os: ["linux"],
						cpu: ["arm64"],
						libc: ["glibc"],
					}),
				"node_modules/@scope/fake-addon-linux-arm64/lib/addon.node":
					elfHeader(AARCH64),
				// The wasm fallback declares no platform at all — npm installs it for every
				// target, so only its name identifies it.
				"node_modules/@scope/fake-addon-wasm32/package.json": pkgJson(
					"@scope/fake-addon-wasm32",
				),
				"node_modules/@scope/fake-addon-wasm32/lib/addon.node.js":
					new TextEncoder().encode("// wasm fallback"),
				// The musl build says so in its own manifest, which is what excludes it.
				"node_modules/@scope/fake-addon-linuxmusl-arm64/package.json":
					pkgJson("@scope/fake-addon-linuxmusl-arm64", {
						os: ["linux"],
						cpu: ["arm64"],
						libc: ["musl"],
					}),
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

	// Under coverage, this 11 MiB ZIP has exceeded Vitest's 5s default in CI.
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
	}, 30_000);
});

/** Read a ZIP archive's entries back into a { path: bytes } map. */
const unzipEntries = (zip: Uint8Array): Record<string, Uint8Array> =>
	unzipSync(zip);

/** Decode an unzipped entry to text. */
const textOf = (data: Uint8Array): string => new TextDecoder().decode(data);

describe("bundleDirectory (zip-directory bundler)", () => {
	let root: string;
	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "neon-zipdir-"));
	});
	afterAll(() => {
		rmSync(root, { recursive: true, force: true });
	});

	/** Build a prebuilt output directory from a { relativePath: contents } map. */
	const buildOutputDir = (files: Record<string, string>): string => {
		const outDir = join(root, `out-${Math.random().toString(36).slice(2)}`);
		for (const [rel, contents] of Object.entries(files)) {
			const abs = join(outDir, rel);
			mkdirSync(join(abs, ".."), { recursive: true });
			writeFileSync(abs, contents);
		}
		return outDir;
	};

	const dirFn = (source: string): ResolvedFunctionConfig => ({
		slug: "fn1",
		name: "Hello World",
		source,
		env: {},
		runtime: "nodejs24",
		bundler: "zip-directory",
	});

	test("ships every file in the directory, preserving nested structure", async () => {
		const source = buildOutputDir({
			"index.mjs": "export default { fetch: () => new Response('ok') };",
			"chunk-abc.mjs": "export const x = 1;",
			"studio/index.html": "<!doctype html><title>Studio</title>",
			"studio/assets/app.js": "console.log('studio');",
		});

		const bundle = await bundleDirectory(dirFn(source));

		expect(Object.keys(bundle).sort()).toEqual([
			"chunk-abc.mjs",
			"index.mjs",
			"studio/assets/app.js",
			"studio/index.html",
		]);
		// Nested keys use POSIX separators regardless of host, so the archive layout is stable.
		expect(textOf(bundle["studio/assets/app.js"])).toBe(
			"console.log('studio');",
		);
	});

	test("resolveFunctionArchive zips the directory into a loadable archive", async () => {
		const source = buildOutputDir({
			"index.mjs": "export default { fetch: () => new Response('ok') };",
			"studio/index.html": "<!doctype html>",
		});

		const zip = await resolveFunctionArchive(dirFn(source));
		const entries = unzipEntries(zip);

		expect(Object.keys(entries).sort()).toEqual([
			"index.mjs",
			"studio/index.html",
		]);
		expect(textOf(entries["index.mjs"])).toContain("fetch");
	});

	test("rejects a directory with no index entry at its root", async () => {
		const source = buildOutputDir({
			"server/index.mjs": "export default {};",
		});

		await expect(bundleDirectory(dirFn(source))).rejects.toThrow(
			/no entry module at its root/,
		);
	});

	test("rejects a source that is a file, not a directory", async () => {
		const source = join(root, "single.mjs");
		writeFileSync(source, "export default {};");

		await expect(bundleDirectory(dirFn(source))).rejects.toThrow(
			/is a file, not a directory/,
		);
	});

	test("rejects a source directory that does not exist", async () => {
		await expect(
			bundleDirectory(dirFn(join(root, "does-not-exist"))),
		).rejects.toThrow(/does not exist/);
	});
});

describe("resolveFunctionArchive (inline function bundler)", () => {
	const inlineFn = (
		bundler: (fn: ResolvedFunctionConfig) => Promise<FunctionBundle>,
	): ResolvedFunctionConfig => ({
		slug: "fn1",
		name: "Hello World",
		source: "unused-by-inline-bundler",
		env: {},
		runtime: "nodejs24",
		bundler,
	});

	test("zips whatever file map the inline bundler returns", async () => {
		const zip = await resolveFunctionArchive(
			inlineFn(async () => ({
				"index.mjs": new TextEncoder().encode(
					"export default { fetch: () => new Response('inline') };",
				),
				"data/thing.json": new TextEncoder().encode('{"a":1}'),
			})),
		);
		const entries = unzipEntries(zip);

		expect(Object.keys(entries).sort()).toEqual([
			"data/thing.json",
			"index.mjs",
		]);
		expect(textOf(entries["index.mjs"])).toContain("inline");
	});

	test("enforces the archive limits on an inline bundler's output", async () => {
		// Trip the entry-count limit rather than the byte limits: same code path
		// (`enforceLimits` in `zipFunctionBundle`), without allocating megabytes.
		const entry = new TextEncoder().encode("export default {};");
		const files: FunctionBundle = { "index.mjs": entry };
		for (let i = 0; i < 4100; i++) {
			files[`chunk-${i}.mjs`] = entry;
		}

		await expect(
			resolveFunctionArchive(inlineFn(async () => files)),
		).rejects.toThrow(/files; the limit is/);
	});

	test("routes the esbuild default through buildFunctionBundle unchanged", async () => {
		const source = join(dir, "esbuild-default.ts");
		writeFileSync(
			source,
			"export default { fetch: () => new Response('hi') };",
		);

		const viaResolve = await resolveFunctionArchive(fn(source), {
			onWarning: collectWarning,
		});
		const viaBuild = await buildFunctionBundle(fn(source), {
			onWarning: collectWarning,
		});

		// Same entry set as the direct esbuild path — the dispatch is a pass-through for esbuild.
		expect(Object.keys(unzipEntries(viaResolve))).toEqual(
			Object.keys(unzipEntries(viaBuild)),
		);
		expect(Object.keys(unzipEntries(viaResolve))).toEqual(["index.mjs"]);
	});
});
