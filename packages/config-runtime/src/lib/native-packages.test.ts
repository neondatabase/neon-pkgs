import {
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
	assertZipWithinLimits,
	RUNTIME_TARGET,
	RUNTIME_TARGET_LABEL,
	traceNativePackages,
} from "./native-packages.js";

/**
 * These cases shell out to `npm` and reach a registry. They run by default rather than
 * behind an opt-in flag: the whole feature is "install the right binary for a platform this
 * machine is not", and a suite that stubs the install cannot tell whether that works.
 *
 * The protected runners have no public egress, but CI's `prepare` action writes an `~/.npmrc`
 * pointing at the Databricks JFrog mirror before anything installs, and a spawned `npm`
 * reads it — so these reach the mirror the same way `pnpm install` does.
 */
const liveTest = test;

let dir: string;
beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), "neon-native-"));
});
afterAll(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("runtime target", () => {
	// The triple that decides which prebuilt binaries are installed. Wrong values here ship
	// binaries that cannot load, so they are asserted rather than left implicit.
	test("is linux-arm64 with glibc", () => {
		expect(RUNTIME_TARGET).toEqual({
			cpu: "arm64",
			os: "linux",
			libc: "glibc",
		});
		expect(RUNTIME_TARGET_LABEL).toBe("linux-arm64 (glibc)");
	});
});

describe("assertZipWithinLimits", () => {
	test("accepts an archive at the limit", () => {
		const zip = new Uint8Array(1024);
		expect(() =>
			assertZipWithinLimits(
				"fn1",
				zip,
				{ "index.mjs": zip },
				{
					maxZipBytes: 1024,
					maxTotalBytes: 1024,
					maxEntries: 10,
				},
			),
		).not.toThrow();
	});

	test("names the largest contributors when over the limit", () => {
		const entries = {
			"index.mjs": new Uint8Array(10),
			"node_modules/big/lib/thing.so.1": new Uint8Array(4096),
			"node_modules/small/index.js": new Uint8Array(100),
		};
		const zip = new Uint8Array(5000);
		const error = (() => {
			try {
				assertZipWithinLimits("fn1", zip, entries, {
					maxZipBytes: 1024,
					maxTotalBytes: 1 << 30,
					maxEntries: 100,
				});
			} catch (e) {
				return e as Error;
			}
			throw new Error("expected a rejection");
		})();

		expect(error.message).toContain("the limit is 0.0 MiB");
		// Largest first, so the message points at what to remove.
		expect(error.message).toContain("node_modules/big/lib/thing.so.1");
		expect(error.message.indexOf("node_modules/big")).toBeLessThan(
			error.message.indexOf("node_modules/small"),
		);
	});

	// The caller is expected to pass the build service's limits rather than rely on a default
	// baked in here, so a change on the service side is one argument, not a code edit.
	test("honours caller-supplied limits", () => {
		const zip = new Uint8Array(2048);
		expect(() =>
			assertZipWithinLimits(
				"fn1",
				zip,
				{ "index.mjs": zip },
				{
					maxZipBytes: 4096,
					maxTotalBytes: 1 << 30,
					maxEntries: 10,
				},
			),
		).not.toThrow();
	});
});

describe("traceNativePackages", () => {
	// The real installer, with an empty PATH so `npm` cannot be found. The packaged CLI ships
	// without npm inside it, so this is a reachable state and the message has to say what to
	// do about it rather than surfacing a bare ENOENT.
	test("reports an actionable error when npm is not on PATH", async () => {
		const path = process.env.PATH;
		process.env.PATH = join(dir, "empty-path");
		try {
			await expect(
				traceNativePackages({
					slug: "fn1",
					packages: ["sharp"],
					projectDir: dir,
				}),
			).rejects.toThrow(/requires "npm" on PATH/);
		} finally {
			process.env.PATH = path;
		}
	});

	test("pins the version resolved in the user's own project", async () => {
		// A package installed locally, standing in for the user's dependency tree.
		const pkg = join(dir, "node_modules", "local-dep");
		writeFileSync(
			join(mkdirp(pkg), "package.json"),
			JSON.stringify({ name: "local-dep", version: "2.3.4" }),
		);

		let requested: string[] = [];
		await traceNativePackages({
			slug: "fn1",
			packages: ["local-dep"],
			projectDir: dir,
			deps: {
				install: async (cwd, specs) => {
					requested = specs;
					writeFileSync(
						join(
							mkdirp(join(cwd, "node_modules", "local-dep")),
							"package.json",
						),
						JSON.stringify({ name: "local-dep", version: "2.3.4" }),
					);
				},
				trace: async () => ["node_modules/local-dep/package.json"],
			},
		});

		// The user's resolution, not the registry's latest — so the deploy stages the version
		// they tested against without reading the binaries beside it.
		expect(requested).toEqual(["local-dep@2.3.4"]);
	});

	/**
	 * The shape that broke this in practice. `sharp` publishes `exports: { "." : … }` with no
	 * `./package.json`, so a `require.resolve("sharp/package.json")` lookup throws
	 * `ERR_PACKAGE_PATH_NOT_EXPORTED` even though the package is installed — and the deploy
	 * silently staged the registry's latest instead of the user's version. Reading the
	 * manifest off disk is what makes the canonical package work.
	 */
	test("pins a package whose exports map hides its package.json", async () => {
		const pkg = join(dir, "node_modules", "exports-only");
		writeFileSync(
			join(mkdirp(pkg), "package.json"),
			JSON.stringify({
				name: "exports-only",
				version: "0.35.3",
				exports: { ".": "./index.js" },
			}),
		);

		let requested: string[] = [];
		await traceNativePackages({
			slug: "fn1",
			packages: ["exports-only"],
			projectDir: dir,
			deps: {
				install: async (cwd, specs) => {
					requested = specs;
					writeFileSync(
						join(
							mkdirp(join(cwd, "node_modules", "exports-only")),
							"package.json",
						),
						JSON.stringify({
							name: "exports-only",
							version: "0.35.3",
						}),
					);
				},
				trace: async () => ["node_modules/exports-only/package.json"],
			},
		});

		expect(requested).toEqual(["exports-only@0.35.3"]);
	});

	/**
	 * A package may export only a subpath — `exports: { "./native": … }` with no `.` — in
	 * which case importing the root throws `ERR_PACKAGE_PATH_NOT_EXPORTED` and the trace
	 * finds nothing. The whole package is still what gets installed.
	 */
	test("installs the package root but traces the specifier as authored", async () => {
		let requested: string[] = [];
		let traceEntry = "";

		await traceNativePackages({
			slug: "fn1",
			packages: ["subpath-pkg/native"],
			projectDir: dir,
			deps: {
				install: async (cwd, specs) => {
					requested = specs;
					writeFileSync(
						join(
							mkdirp(join(cwd, "node_modules", "subpath-pkg")),
							"package.json",
						),
						JSON.stringify({
							name: "subpath-pkg",
							version: "1.0.0",
						}),
					);
				},
				trace: async (base, entry) => {
					traceEntry = readFileSync(join(base, entry), "utf8");
					return ["node_modules/subpath-pkg/package.json"];
				},
			},
		});

		// npm is given the package; the trace entry imports what the user wrote.
		expect(requested).toEqual(["subpath-pkg"]);
		expect(traceEntry).toContain('import "subpath-pkg/native";');
	});

	test("installs a package once when named both bare and through a subpath", async () => {
		let requested: string[] = [];
		await traceNativePackages({
			slug: "fn1",
			packages: ["dual", "dual/sub"],
			projectDir: dir,
			deps: {
				install: async (cwd, specs) => {
					requested = specs;
					writeFileSync(
						join(
							mkdirp(join(cwd, "node_modules", "dual")),
							"package.json",
						),
						JSON.stringify({ name: "dual", version: "1.0.0" }),
					);
				},
				trace: async () => ["node_modules/dual/package.json"],
			},
		});
		expect(requested).toEqual(["dual"]);
	});

	// The variant filter matches package directory names. A substring test over the whole
	// path also deletes an ordinary file that happens to be named like a variant, which
	// would drop a needed file from the archive and fail at invoke.
	test("keeps a normal file whose name merely contains musl", async () => {
		const names = await traceNativePackages({
			slug: "fn1",
			packages: ["plain-pkg"],
			projectDir: dir,
			deps: {
				install: async (cwd) => {
					const pkg = mkdirp(join(cwd, "node_modules", "plain-pkg"));
					writeFileSync(
						join(pkg, "package.json"),
						JSON.stringify({ name: "plain-pkg", version: "1.0.0" }),
					);
					writeFileSync(
						join(mkdirp(join(pkg, "lib")), "musl-helper.js"),
						"module.exports = 1;",
					);
					const musl = mkdirp(
						join(cwd, "node_modules", "thing-musl-arm64"),
					);
					writeFileSync(
						join(musl, "index.js"),
						"module.exports = 2;",
					);
				},
				trace: async () => [
					"node_modules/plain-pkg/package.json",
					"node_modules/plain-pkg/lib/musl-helper.js",
					"node_modules/thing-musl-arm64/index.js",
				],
			},
		}).then((r) => Object.keys(r.entries));

		expect(names).toContain("node_modules/plain-pkg/lib/musl-helper.js");
		// The actual musl variant package is still dropped.
		expect(names).not.toContain("node_modules/thing-musl-arm64/index.js");
	});

	test("pins a scoped package the same way", async () => {
		const pkg = join(dir, "node_modules", "@scope", "dep");
		writeFileSync(
			join(mkdirp(pkg), "package.json"),
			JSON.stringify({ name: "@scope/dep", version: "1.2.3" }),
		);

		let requested: string[] = [];
		await traceNativePackages({
			slug: "fn1",
			packages: ["@scope/dep"],
			projectDir: dir,
			deps: {
				install: async (cwd, specs) => {
					requested = specs;
					writeFileSync(
						join(
							mkdirp(join(cwd, "node_modules", "@scope", "dep")),
							"package.json",
						),
						JSON.stringify({
							name: "@scope/dep",
							version: "1.2.3",
						}),
					);
				},
				trace: async () => ["node_modules/@scope/dep/package.json"],
			},
		});

		expect(requested).toEqual(["@scope/dep@1.2.3"]);
	});

	test("falls back to an unpinned spec when the package is not installed locally", async () => {
		let requested: string[] = [];
		await traceNativePackages({
			slug: "fn1",
			packages: ["not-installed-locally"],
			projectDir: dir,
			deps: {
				install: async (cwd, specs) => {
					requested = specs;
					writeFileSync(
						join(
							mkdirp(
								join(
									cwd,
									"node_modules",
									"not-installed-locally",
								),
							),
							"package.json",
						),
						JSON.stringify({
							name: "not-installed-locally",
							version: "1.0.0",
						}),
					);
				},
				trace: async () => [
					"node_modules/not-installed-locally/package.json",
				],
			},
		});
		expect(requested).toEqual(["not-installed-locally"]);
	});

	test("never reads the user's node_modules for the shipped files", async () => {
		// A file that exists only in the user's tree. If it reaches the archive, the deploy is
		// shipping host-architecture binaries — the failure mode this design exists to avoid.
		const userPkg = join(dir, "node_modules", "host-arch-dep");
		writeFileSync(
			join(mkdirp(userPkg), "package.json"),
			JSON.stringify({ name: "host-arch-dep", version: "1.0.0" }),
		);
		writeFileSync(
			join(userPkg, "host-only.node"),
			"from the user's laptop",
		);

		const message = await traceNativePackages({
			slug: "fn1",
			packages: ["host-arch-dep"],
			projectDir: dir,
			deps: {
				install: async (cwd) => {
					writeFileSync(
						join(
							mkdirp(join(cwd, "node_modules", "host-arch-dep")),
							"package.json",
						),
						JSON.stringify({
							name: "host-arch-dep",
							version: "1.0.0",
						}),
					);
				},
				// Report the user's file as traced. Every traced path is resolved inside the
				// staging tree, so this one is not found there — and is never fetched from the
				// project instead.
				trace: async () => [
					"node_modules/host-arch-dep/package.json",
					"node_modules/host-arch-dep/host-only.node",
				],
			},
		}).then(
			() => "unexpectedly succeeded",
			(e: unknown) => (e as Error).message,
		);

		// A traced file that is not in staging is an anomaly, and shipping an archive that is
		// quietly missing a file fails at invoke — the failure this path exists to prevent.
		// What matters here is that the host binary was not silently substituted for it.
		expect(message).toMatch(/host-only\.node" disappeared/);
		expect(readFileSync(join(userPkg, "host-only.node"), "utf8")).toBe(
			"from the user's laptop",
		);
	});

	/**
	 * The real thing: install `sharp` for the runtime target and check what would ship.
	 *
	 * A test that merely imports sharp successfully proves nothing — its loader falls through
	 * several tiers silently, so on an x64 host it can report success having loaded the
	 * WebAssembly fallback. These assert the *binary* that would be shipped: the linux-arm64
	 * package is present, it is an aarch64 ELF, its libvips sibling ships too, and the wasm
	 * and musl variants are gone.
	 */
	liveTest(
		"installs and traces a real sharp for the runtime target",
		async () => {
			const { entries } = await traceNativePackages({
				slug: "resize",
				packages: ["sharp"],
				projectDir: dir,
				limits: {
					maxZipBytes: 64 * 1024 * 1024,
					maxTotalBytes: 256 * 1024 * 1024,
					maxEntries: 16384,
				},
			});
			const names = Object.keys(entries);

			// The addon for the runtime, and the shared library it loads relative to itself.
			const addon = names.find((n) =>
				/@img\/sharp-linux-arm64\/lib\/.*\.node$/.test(n),
			);
			expect(addon).toBeDefined();
			const libvips = names.find((n) =>
				/@img\/sharp-libvips-linux-arm64\/lib\/libvips-cpp\.so/.test(n),
			);
			expect(libvips).toBeDefined();

			// aarch64 ELF, not the host's x64 build.
			const header = Buffer.from(entries[addon as string]);
			expect(header.subarray(0, 4).toString("binary")).toBe("\x7fELF");
			expect(header.readUInt16LE(18)).toBe(0xb7);

			// The tiers sharp would otherwise fall through to, so a broken native path fails
			// loudly instead of quietly running slower code.
			expect(names.filter((n) => n.includes("wasm32"))).toEqual([]);
			expect(names.filter((n) => n.includes("musl"))).toEqual([]);

			// The layout the dynamic linker walks: the addon and its library are siblings under
			// node_modules/@img, not flattened together.
			expect(addon).toMatch(
				/^node_modules\/@img\/sharp-linux-arm64\/lib\//,
			);
			expect(libvips).toMatch(
				/^node_modules\/@img\/sharp-libvips-linux-arm64\/lib\//,
			);
		},
		180_000,
	);

	// A package that declares a platform the runtime is not. npm rejects it as EBADPLATFORM
	// with a message comparing against the *host*, which reads as though the wrong thing was
	// asked for; the deploy has to say what actually happened.
	liveTest(
		"fails the deploy when a package has no build for the runtime target",
		async () => {
			const message = await traceNativePackages({
				slug: "fn1",
				packages: ["@img/sharp-win32-x64"],
				projectDir: dir,
			}).then(
				() => "unexpectedly succeeded",
				(e: unknown) => (e as Error).message,
			);

			expect(message).toMatch(
				/has no build for the Functions runtime \(linux-arm64 \(glibc\)\)/,
			);
			expect(message).toContain("sharp does");
		},
		180_000,
	);
});

function mkdirp(path: string): string {
	mkdirSync(path, { recursive: true });
	return path;
}
