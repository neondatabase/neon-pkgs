import { type Dirent, readdirSync } from "node:fs";
import { join } from "node:path";
import { externalPackageRoot } from "@neon/config";
import { RUNTIME_TARGET } from "./native-packages.js";
import { findPackageDir, readPackageManifest } from "./resolve-package.js";

/**
 * Why a package looks like it needs its files shipped. Carried through to the message so the
 * report states the evidence rather than a prediction about what will happen at invoke.
 */
export type NativeEvidence =
	| { kind: "binary"; file: string }
	| { kind: "platformDependency"; dependency: string; file: string }
	| { kind: "buildsFromSource"; script: string }
	| { kind: "prebuiltManifest" };

export type NativeFinding = {
	/** The package as it appears in the user's tree. */
	name: string;
	evidence: NativeEvidence;
};

/** Depth of the walk for a `.node`/`.so` inside one package. */
const SCAN_DEPTH = 4;

const BINARY_PATTERN = /\.(node|so)(\.\d+)*$/;

const GYP_PATTERN = /\b(node-gyp|node-pre-gyp|prebuild-install|cmake-js)\b/;

type Manifest = {
	os?: string[];
	cpu?: string[];
	libc?: string[];
	binary?: unknown;
	optionalDependencies?: Record<string, string>;
	scripts?: Record<string, string>;
};

/**
 * The packages a bundle pulled in that carry native code and were not declared in
 * `externalPackages`.
 *
 * **This is evidence, not a verdict.** It proves the package contains or depends on compiled
 * code, never that this function's code path reaches it — a package with an optional native
 * accelerator and a working JavaScript fallback (`ws` with `bufferutil`, a Prisma client with
 * no Rust engine) looks identical from here and deploys fine today. So the caller reports it
 * and continues; it must not fail a deploy.
 *
 * Only reachable after a successful build. A package esbuild could not resolve, or a `.node`
 * it has no loader for, throws before any metafile exists — those already fail loudly with
 * esbuild's own diagnostic.
 */
export function findUndeclaredNativePackages(options: {
	metafile: { inputs?: Record<string, unknown> } | undefined;
	declared: readonly string[];
	projectDir: string;
}): NativeFinding[] {
	const { metafile, declared, projectDir } = options;
	const inputs = metafile?.inputs;
	if (!inputs) return [];

	// A declared subpath covers its whole package: esbuild externalizing `pkg` externalizes
	// `pkg/sub` with it, so the package is spoken for either way.
	const declaredRoots = new Set(declared.map(externalPackageRoot));

	const findings: NativeFinding[] = [];
	const seen = new Set<string>();
	for (const input of Object.keys(inputs)) {
		const name = packageNameFromInput(input);
		if (name === undefined) continue;
		if (declaredRoots.has(name) || seen.has(name)) continue;
		seen.add(name);

		const evidence = nativeEvidence(projectDir, name);
		if (evidence !== undefined) findings.push({ name, evidence });
	}
	return findings;
}

/**
 * The package an esbuild metafile input belongs to, or `undefined` for the user's own source.
 *
 * Keyed off the **last** `node_modules/` segment, which is what makes pnpm's
 * `node_modules/.pnpm/sharp@0.35.3/node_modules/sharp/lib/x.js` resolve to `sharp` rather
 * than `.pnpm`. Yarn PnP resolves out of zip archives with no `node_modules` segment at all
 * and yields nothing here, which is the safe direction: a missed package is a missing
 * warning, not a wrong one.
 */
export function packageNameFromInput(input: string): string | undefined {
	const normalized = input.split("\\").join("/");
	const marker = "node_modules/";
	const last = normalized.lastIndexOf(marker);
	if (last === -1) return undefined;

	const rest = normalized.slice(last + marker.length);
	const segments = rest.split("/").filter((segment) => segment.length > 0);
	if (segments.length === 0) return undefined;
	if (segments[0].startsWith("@")) {
		return segments.length >= 2
			? `${segments[0]}/${segments[1]}`
			: undefined;
	}
	return segments[0];
}

const readManifest = (dir: string): Manifest | undefined =>
	readPackageManifest(dir) as Manifest | undefined;

/**
 * Whether a manifest's own `os`/`cpu` fields permit the Functions runtime. A package that
 * excludes it — `fsevents` is darwin-only — cannot run there whatever we do, so it is not a
 * candidate for shipping and reporting it would be noise.
 */
function runsOnRuntime(manifest: Manifest): boolean {
	const permits = (
		field: readonly string[] | undefined,
		value: string,
	): boolean => {
		if (field === undefined || field.length === 0) return true;
		if (field.some((entry) => entry === `!${value}`)) return false;
		const positives = field.filter((entry) => !entry.startsWith("!"));
		return positives.length === 0 || positives.includes(value);
	};
	return (
		permits(manifest.os, RUNTIME_TARGET.os) &&
		permits(manifest.cpu, RUNTIME_TARGET.cpu)
	);
}

/** The first native signal a package shows, or `undefined` if it looks like plain JavaScript. */
function nativeEvidence(
	projectDir: string,
	name: string,
): NativeEvidence | undefined {
	const dir = findPackageDir(projectDir, name);
	if (dir === undefined) return undefined;

	const manifest = readManifest(dir);
	if (manifest === undefined) return undefined;
	if (!runsOnRuntime(manifest)) return undefined;

	const own = findBinary(dir, SCAN_DEPTH);
	if (own !== undefined) return { kind: "binary", file: own };

	// The modern prebuilt pattern: the parent is pure JavaScript and the binary lives in a
	// platform-gated optional dependency, which is why scanning only the parent misses it.
	for (const dependency of Object.keys(manifest.optionalDependencies ?? {})) {
		const dependencyDir = findPackageDir(projectDir, dependency);
		if (dependencyDir === undefined) continue;
		const dependencyManifest = readManifest(dependencyDir);
		if (dependencyManifest === undefined) continue;
		// The sibling built for *this* host is the one installed locally; its os/cpu fields
		// are what mark the package as platform-gated at all.
		const platformGated =
			dependencyManifest.os !== undefined ||
			dependencyManifest.cpu !== undefined;
		if (!platformGated) continue;
		const file = findBinary(dependencyDir, SCAN_DEPTH);
		if (file !== undefined)
			return { kind: "platformDependency", dependency, file };
	}

	const script = manifest.scripts?.install ?? manifest.scripts?.postinstall;
	if (script !== undefined && GYP_PATTERN.test(script))
		return { kind: "buildsFromSource", script };

	if (manifest.binary !== undefined) return { kind: "prebuiltManifest" };

	return undefined;
}

/** First compiled artifact under `dir`, not descending into a nested `node_modules`. */
function findBinary(dir: string, depth: number): string | undefined {
	if (depth < 0) return undefined;
	let listing: Dirent[];
	try {
		listing = readdirSync(dir, { withFileTypes: true });
	} catch {
		return undefined;
	}
	for (const entry of listing) {
		if (entry.isFile() && BINARY_PATTERN.test(entry.name))
			return entry.name;
	}
	for (const entry of listing) {
		if (!entry.isDirectory() || entry.name === "node_modules") continue;
		const found = findBinary(join(dir, entry.name), depth - 1);
		if (found !== undefined) return join(entry.name, found);
	}
	return undefined;
}

/**
 * The report a user sees. States what was found and both ways to act on it, with the
 * shipping form first because it is the one that produces a working function.
 */
export function describeNativeFinding(
	slug: string,
	finding: NativeFinding,
): string {
	const { name, evidence } = finding;
	const because = (() => {
		switch (evidence.kind) {
			case "binary":
				return `it contains a compiled binary (${evidence.file})`;
			case "platformDependency":
				return `it loads a compiled binary from ${evidence.dependency} (${evidence.file})`;
			case "buildsFromSource":
				return `it compiles a binary at install time (${evidence.script})`;
			case "prebuiltManifest":
				return "its manifest declares a prebuilt binary";
		}
	})();

	return [
		`Function "${slug}" bundles "${name}", and ${because}.`,
		`A compiled binary cannot be bundled, so if this function reaches that code path it`,
		`will fail at invoke rather than at deploy.`,
		"",
		`  Ship its files with the deploy:`,
		`      externalPackages: ["${name}"]`,
		"",
		`  Or, if this function never reaches it, silence this by saying so:`,
		`      externalPackages: [{ name: "${name}", includeFiles: false }]`,
		"",
		`Shipping a package adds its whole file tree to the archive, which increases both`,
		`archive size and cold start. If "${name}" is only used behind a JavaScript fallback,`,
		`the deploy is already correct and the second form records that.`,
	].join("\n");
}
