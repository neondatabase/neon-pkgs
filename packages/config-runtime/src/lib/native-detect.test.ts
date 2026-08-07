import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
	describeNativeFinding,
	findUndeclaredNativePackages,
	packageNameFromInput,
} from "./native-detect.js";

/**
 * Fixtures are real directory trees rather than a faked filesystem: the thing under test is
 * how a package looks on disk, so a stub would be asserting against my own model of npm's
 * layout instead of npm's.
 */
let root: string;
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "neon-detect-"));
});
afterEach(() => {
	rmSync(root, { recursive: true, force: true });
});

type PackageSpec = {
	manifest?: Record<string, unknown>;
	files?: Record<string, string>;
};

const writePackage = (name: string, spec: PackageSpec = {}): string => {
	const dir = join(root, "node_modules", ...name.split("/"));
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, "package.json"),
		JSON.stringify({ name, version: "1.0.0", ...(spec.manifest ?? {}) }),
	);
	for (const [relative, contents] of Object.entries(spec.files ?? {})) {
		const target = join(dir, relative);
		mkdirSync(join(target, ".."), { recursive: true });
		writeFileSync(target, contents);
	}
	return dir;
};

/** A metafile naming one bundled file inside each given package. */
const metafileFor = (...packages: string[]) => ({
	inputs: Object.fromEntries([
		["entry.ts", {}],
		...packages.map((name) => [`node_modules/${name}/index.js`, {}]),
	]),
});

const find = (metafile: unknown, declared: string[] = []) =>
	findUndeclaredNativePackages({
		metafile: metafile as { inputs?: Record<string, unknown> },
		declared,
		projectDir: root,
	});

describe("packageNameFromInput", () => {
	test("reads a bare package name", () => {
		expect(packageNameFromInput("node_modules/sharp/lib/index.js")).toBe(
			"sharp",
		);
	});

	test("reads a scoped package name", () => {
		expect(packageNameFromInput("node_modules/@img/colour/index.js")).toBe(
			"@img/colour",
		);
	});

	// pnpm's store puts the real package behind a second node_modules, so anchoring on the
	// first segment would report `.pnpm` for every dependency in a pnpm project.
	test("reads through pnpm's store layout", () => {
		expect(
			packageNameFromInput(
				"node_modules/.pnpm/sharp@0.35.3/node_modules/sharp/lib/index.js",
			),
		).toBe("sharp");
	});

	test("reads a scoped package through pnpm's store layout", () => {
		expect(
			packageNameFromInput(
				"node_modules/.pnpm/@img+sharp-linux-arm64@0.35.3/node_modules/@img/sharp-linux-arm64/lib/x.js",
			),
		).toBe("@img/sharp-linux-arm64");
	});

	test("handles windows separators", () => {
		expect(packageNameFromInput("node_modules\\sharp\\lib\\index.js")).toBe(
			"sharp",
		);
	});

	test("returns undefined for the user's own source", () => {
		expect(packageNameFromInput("src/functions/resize.ts")).toBeUndefined();
	});

	test("returns undefined for a scope with no package", () => {
		expect(packageNameFromInput("node_modules/@img/")).toBeUndefined();
	});
});

describe("findUndeclaredNativePackages", () => {
	test("finds nothing when every bundled package is plain JavaScript", () => {
		writePackage("lodash", {
			files: { "index.js": "module.exports = {};" },
		});
		expect(find(metafileFor("lodash"))).toEqual([]);
	});

	test("flags a package containing a .node binary", () => {
		writePackage("better-sqlite3", {
			files: { "build/Release/better_sqlite3.node": "\x7fELF" },
		});
		const findings = find(metafileFor("better-sqlite3"));
		expect(findings).toHaveLength(1);
		expect(findings[0].name).toBe("better-sqlite3");
		expect(findings[0].evidence.kind).toBe("binary");
	});

	// The shape that matters most: `sharp` itself is pure JavaScript, and the binary lives in
	// a platform-gated optional dependency. Scanning only the parent finds nothing.
	test("flags a package whose binary lives in a platform optional dependency", () => {
		writePackage("sharp", {
			manifest: {
				optionalDependencies: { "@img/sharp-darwin-arm64": "0.35.3" },
			},
			files: { "lib/index.js": "module.exports = {};" },
		});
		writePackage("@img/sharp-darwin-arm64", {
			manifest: { os: ["darwin"], cpu: ["arm64"] },
			files: { "lib/sharp-darwin-arm64.node": "\x7fELF" },
		});

		const findings = find(metafileFor("sharp"));
		expect(findings).toHaveLength(1);
		expect(findings[0].name).toBe("sharp");
		expect(findings[0].evidence).toMatchObject({
			kind: "platformDependency",
			dependency: "@img/sharp-darwin-arm64",
		});
	});

	test("flags a package that compiles from source at install time", () => {
		writePackage("some-addon", {
			manifest: { scripts: { install: "node-gyp rebuild" } },
			files: { "index.js": "module.exports = {};" },
		});
		const findings = find(metafileFor("some-addon"));
		expect(findings[0]?.evidence.kind).toBe("buildsFromSource");
	});

	test("flags a node-pre-gyp package by its binary manifest field", () => {
		writePackage("pre-gyp-thing", {
			manifest: { binary: { module_name: "thing" } },
			files: { "index.js": "module.exports = {};" },
		});
		expect(find(metafileFor("pre-gyp-thing"))[0]?.evidence.kind).toBe(
			"prebuiltManifest",
		);
	});

	test("says nothing about a package already declared", () => {
		writePackage("better-sqlite3", {
			files: { "build/Release/better_sqlite3.node": "\x7fELF" },
		});
		expect(find(metafileFor("better-sqlite3"), ["better-sqlite3"])).toEqual(
			[],
		);
	});

	// Externalizing `pkg` externalizes `pkg/sub` with it, so a subpath declaration speaks for
	// the whole package and must not leave it looking undeclared.
	test("treats a declared subpath as covering its package", () => {
		writePackage("better-sqlite3", {
			files: { "build/Release/better_sqlite3.node": "\x7fELF" },
		});
		expect(
			find(metafileFor("better-sqlite3"), [
				"better-sqlite3/lib/index.js",
			]),
		).toEqual([]);
	});

	// `fsevents` is darwin-only. It cannot run on the runtime whatever we do, so it is not a
	// candidate for shipping and reporting it would be pure noise on every macOS project.
	test("ignores a package that cannot run on the runtime at all", () => {
		writePackage("fsevents", {
			manifest: { os: ["darwin"] },
			files: { "fsevents.node": "\x7fELF" },
		});
		expect(find(metafileFor("fsevents"))).toEqual([]);
	});

	test("ignores a package excluded from the runtime by cpu", () => {
		writePackage("x64-only", {
			manifest: { cpu: ["x64"] },
			files: { "thing.node": "\x7fELF" },
		});
		expect(find(metafileFor("x64-only"))).toEqual([]);
	});

	test("honours a negated os field", () => {
		writePackage("not-linux", {
			manifest: { os: ["!linux"] },
			files: { "thing.node": "\x7fELF" },
		});
		expect(find(metafileFor("not-linux"))).toEqual([]);
	});

	test("does not look inside a nested node_modules", () => {
		writePackage("outer", {
			files: { "index.js": "module.exports = {};" },
		});
		mkdirSync(
			join(root, "node_modules", "outer", "node_modules", "inner"),
			{
				recursive: true,
			},
		);
		writeFileSync(
			join(
				root,
				"node_modules",
				"outer",
				"node_modules",
				"inner",
				"thing.node",
			),
			"\x7fELF",
		);
		expect(find(metafileFor("outer"))).toEqual([]);
	});

	test("reports a package once however many of its files were bundled", () => {
		writePackage("better-sqlite3", {
			files: { "build/Release/better_sqlite3.node": "\x7fELF" },
		});
		const metafile = {
			inputs: {
				"node_modules/better-sqlite3/index.js": {},
				"node_modules/better-sqlite3/lib/database.js": {},
			},
		};
		expect(find(metafile)).toHaveLength(1);
	});

	test("returns nothing when esbuild produced no metafile", () => {
		expect(find(undefined)).toEqual([]);
	});

	test("ignores a package that is in the graph but not installed", () => {
		expect(find(metafileFor("never-installed"))).toEqual([]);
	});
});

describe("describeNativeFinding", () => {
	test("leads with the shipping fix and offers the opt-out second", () => {
		const message = describeNativeFinding("resize", {
			name: "sharp",
			evidence: {
				kind: "platformDependency",
				dependency: "@img/sharp-linux-arm64",
				file: "lib/sharp.node",
			},
		});

		expect(message).toContain('Function "resize" bundles "sharp"');
		expect(message).toContain("@img/sharp-linux-arm64");
		expect(message).toContain('externalPackages: ["sharp"]');
		expect(message).toContain(
			'externalPackages: [{ name: "sharp", includeFiles: false }]',
		);
		// The shipping form comes first: it is the one that produces a working function.
		expect(message.indexOf('externalPackages: ["sharp"]')).toBeLessThan(
			message.indexOf("includeFiles: false"),
		);
	});

	// The evidence proves the package carries native code, never that this function reaches
	// it, so the failure has to be stated as conditional and the no-change-needed case has
	// to be named. `ws` with `bufferutil` installed is exactly that case.
	test("states the failure conditionally and allows for a working fallback", () => {
		const message = describeNativeFinding("resize", {
			name: "ws",
			evidence: { kind: "binary", file: "build/Release/bufferutil.node" },
		});
		expect(message).toContain("if this function reaches that code path");
		expect(message).toContain("the deploy is already correct");
	});
});
