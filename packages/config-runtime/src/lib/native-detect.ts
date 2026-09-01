import { type Dirent, readdirSync, realpathSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { externalPackageRoot } from "@neon/config";
import { RUNTIME_TARGET, RUNTIME_TARGET_LABEL } from "./native-packages.js";
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

/**
 * Third-party manifests are arbitrary JSON, so every field is `unknown` and narrowed at use.
 * npm accepts `os`/`cpu`/`libc` as a bare string as well as an array.
 */
type Manifest = {
	os?: unknown;
	cpu?: unknown;
	libc?: unknown;
	binary?: unknown;
	optionalDependencies?: unknown;
	scripts?: Record<string, unknown>;
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
	/** What metafile input paths are relative to. Defaults to the process working directory. */
	cwd?: string;
}): NativeFinding[] {
	const { metafile, declared, projectDir } = options;
	const cwd = options.cwd ?? process.cwd();
	const inputs = metafile?.inputs;
	if (!inputs) return [];

	// A declared subpath covers its whole package: esbuild externalizing `pkg` externalizes
	// `pkg/sub` with it, so the package is spoken for either way.
	const declaredRoots = new Set(declared.map(externalPackageRoot));

	const findings: NativeFinding[] = [];
	const seen = new Set<string>();
	for (const input of Object.keys(inputs)) {
		const located = packageFromInput(input, cwd);
		if (located === undefined) continue;
		const { name } = located;
		if (declaredRoots.has(name)) continue;

		// Keyed by directory, not name: pnpm and nested installs can put two versions of one
		// package in a graph, and they are genuinely different packages to inspect.
		const dir = located.dir ?? findPackageDir(projectDir, name);
		if (dir === undefined || seen.has(dir)) continue;
		seen.add(dir);

		const evidence = nativeEvidence(dir, projectDir);
		if (evidence !== undefined) findings.push({ name, evidence });
	}
	return findings;
}

/**
 * The package an input belongs to, and where that exact copy lives on disk.
 *
 * Taking the directory straight from the input path rather than searching for the name is
 * what makes this correct under pnpm, whose transitive dependencies are not linked at the
 * project root at all and whose store holds several versions of the same package side by
 * side. A search from the project root would miss the first and could inspect the wrong copy
 * in the second.
 */
function packageFromInput(
	input: string,
	cwd: string,
): { name: string; dir?: string } | undefined {
	const name = packageNameFromInput(input);
	if (name === undefined) return undefined;

	const normalized = input.split("\\").join("/");
	const marker = "node_modules/";
	const last = normalized.lastIndexOf(marker);
	// The path through the end of the package's own segments is its directory.
	const prefixLength = last + marker.length + name.length;
	const relativeDir = normalized.slice(0, prefixLength);
	if (!relativeDir.endsWith(name)) return { name };

	const absolute = isAbsolute(relativeDir)
		? relativeDir
		: resolve(cwd, relativeDir);
	try {
		// realpath so a pnpm symlink and its store target dedupe to one physical package.
		return { name, dir: realpathSync(absolute) };
	} catch {
		// The path esbuild reported is not readable from here — fall back to a search.
		return { name };
	}
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
 * A manifest field npm accepts as either a string or an array of strings, narrowed to a list.
 * Anything else is treated as absent: this is an advisory scan reading arbitrary third-party
 * manifests, and a malformed field must not take a deploy down.
 */
function stringList(value: unknown): string[] | undefined {
	if (typeof value === "string") return [value];
	if (!Array.isArray(value)) return undefined;
	const entries = value.filter(
		(entry): entry is string => typeof entry === "string",
	);
	return entries.length === value.length ? entries : undefined;
}

function optionalDependencies(manifest: Manifest): Record<string, unknown> {
	const value = manifest.optionalDependencies;
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

/**
 * Whether a manifest's own `os`/`cpu`/`libc` fields permit the Functions runtime. A package
 * that excludes it — `fsevents` is darwin-only, a musl-only build cannot load on glibc —
 * cannot run there whatever we do, so it is not a candidate for shipping and reporting it
 * would be noise.
 */
function runsOnRuntime(manifest: Manifest): boolean {
	const permits = (raw: unknown, value: string): boolean => {
		const field = stringList(raw);
		if (field === undefined || field.length === 0) return true;
		if (field.some((entry) => entry === `!${value}`)) return false;
		const positives = field.filter((entry) => !entry.startsWith("!"));
		return positives.length === 0 || positives.includes(value);
	};
	return (
		permits(manifest.os, RUNTIME_TARGET.os) &&
		permits(manifest.cpu, RUNTIME_TARGET.cpu) &&
		permits(manifest.libc, RUNTIME_TARGET.libc)
	);
}

/** The first native signal a package shows, or `undefined` if it looks like plain JavaScript. */
function nativeEvidence(
	dir: string,
	projectDir: string,
): NativeEvidence | undefined {
	const manifest = readManifest(dir);
	if (manifest === undefined) return undefined;
	if (!runsOnRuntime(manifest)) return undefined;

	const own = findBinary(dir, SCAN_DEPTH);
	if (own !== undefined) return { kind: "binary", file: own };

	// The modern prebuilt pattern: the parent is pure JavaScript and the binary lives in a
	// platform-gated optional dependency, which is why scanning only the parent misses it.
	for (const dependency of Object.keys(optionalDependencies(manifest))) {
		// Search from the package's own directory first so a nested or pnpm-linked copy wins
		// over an unrelated one at the project root, then fall back to the project.
		const dependencyDir =
			findPackageDir(dir, dependency) ??
			findPackageDir(projectDir, dependency);
		if (dependencyDir === undefined) continue;
		const dependencyManifest = readManifest(dependencyDir);
		if (dependencyManifest === undefined) continue;
		// The sibling built for *this* host is the one installed locally; its os/cpu fields
		// are what mark the package as platform-gated at all.
		const platformGated =
			stringList(dependencyManifest.os) !== undefined ||
			stringList(dependencyManifest.cpu) !== undefined ||
			stringList(dependencyManifest.libc) !== undefined;
		if (!platformGated) continue;
		const file = findBinary(dependencyDir, SCAN_DEPTH);
		if (file !== undefined)
			return { kind: "platformDependency", dependency, file };
	}

	const scripts = manifest.scripts;
	const script =
		typeof scripts?.install === "string"
			? scripts.install
			: typeof scripts?.postinstall === "string"
				? scripts.postinstall
				: undefined;
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
	// The evidence comes from the tree on *this* machine, so it names the host's build. Said
	// out loud, because otherwise a linux-arm64 deploy reporting a darwin binary reads as a
	// bug in the tool rather than as a description of the developer's own node_modules.
	const because = (() => {
		switch (evidence.kind) {
			case "binary":
				return `it contains a compiled binary (${evidence.file} on this machine; the deploy needs the ${RUNTIME_TARGET_LABEL} build)`;
			case "platformDependency":
				return `it loads a compiled binary from ${evidence.dependency} (${evidence.file} on this machine; the deploy needs the ${RUNTIME_TARGET_LABEL} build)`;
			case "buildsFromSource":
				return `it compiles a binary at install time (${evidence.script})`;
			case "prebuiltManifest":
				return "its manifest declares a prebuilt binary";
		}
	})();

	return [
		`Function "${slug}" bundles "${name}", and ${because}.`,
		`A compiled binary cannot be bundled, so if this function evaluates that import it`,
		`fails at invoke rather than at deploy.`,
		"",
		`  Ship its files with the deploy:`,
		`      externalPackages: ["${name}"]`,
		"",
		`If "${name}" is only reached behind a working JavaScript fallback, this deploy is`,
		`already correct and needs no change — this is advisory and never fails a deploy.`,
		`Do not add includeFiles: false to silence it: that externalizes "${name}" and ships`,
		`nothing for it, so a top-level import of it would then fail on every invoke.`,
	].join("\n");
}
