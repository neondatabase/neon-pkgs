import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import {
	dirname,
	extname,
	isAbsolute,
	join,
	relative,
	resolve,
	sep,
} from "node:path";
import { analyzeNeonConfig, type ConfigAnalysis } from "./config-editor.js";

/**
 * Config filenames the runtime loads, mirroring `@neon/config`'s `DEFAULT_CONFIG_FILENAMES`.
 * `.cts` is accepted when named explicitly via `--config` but never auto-discovered, matching
 * the loader's search set.
 */
export const NEON_CONFIG_FILENAMES = [
	"neon.ts",
	"neon.mts",
	"neon.js",
	"neon.mjs",
] as const;

export type DiscoveredConfig = {
	/** Absolute path to the config file. */
	path: string;
	/** Directory the config lives in — the project root for containment checks. */
	root: string;
	source: string;
	/** File extension without the dot (`ts`, `mts`, `cts`, `js`, `mjs`). */
	extension: string;
	analysis: ConfigAnalysis;
};

export type DiscoveryResult =
	| { kind: "found"; config: DiscoveredConfig }
	| { kind: "blocked"; path: string; reason: string }
	| { kind: "missing" }
	| { kind: "ambiguous"; dir: string; names: string[] };

const isFile = (path: string): boolean => {
	try {
		return statSync(path).isFile();
	} catch {
		return false;
	}
};

const safeRealpath = (path: string): string => {
	try {
		return realpathSync(path);
	} catch {
		return resolve(path);
	}
};

const isInside = (root: string, candidate: string): boolean =>
	candidate === root || candidate.startsWith(root + sep);

/** Real path of the deepest existing ancestor of `target` (which may not exist yet). */
const realpathExistingPrefix = (target: string): string => {
	let current = resolve(target);
	while (!existsSync(current)) {
		const parent = dirname(current);
		if (parent === current) return safeRealpath(current);
		current = parent;
	}
	return safeRealpath(current);
};

const loadDiscovered = (dir: string, name: string): DiscoveryResult => {
	const path = join(dir, name);
	const realPath = safeRealpath(path);
	const realRoot = safeRealpath(dir);
	if (!isInside(realRoot, realPath)) {
		return {
			kind: "blocked",
			path,
			reason: "the config file is a symlink that escapes the project root",
		};
	}
	const source = readFileSync(path, "utf8");
	const extension = extname(name).slice(1).toLowerCase();
	return {
		kind: "found",
		config: {
			path,
			root: dir,
			source,
			extension,
			analysis: analyzeNeonConfig(source, extension),
		},
	};
};

/**
 * Walk upward from `cwd` for a supported Neon config file, stopping at the nearest Git/project
 * boundary. The **nearest** candidate always wins: a directory with a supported config ends the
 * search there, even when that file turns out not to be safely editable — a decoy or malformed
 * config at a nearer level must never be skipped in favor of mutating a farther parent. Multiple
 * candidates in one directory are ambiguous and stop the search too.
 */
export const discoverConfig = (cwd: string): DiscoveryResult => {
	let current = resolve(cwd);
	const visited = new Set<string>();
	while (true) {
		const present = NEON_CONFIG_FILENAMES.filter((name) =>
			isFile(join(current, name)),
		);
		if (present.length > 1) {
			return { kind: "ambiguous", dir: current, names: present };
		}
		if (present.length === 1) {
			return loadDiscovered(current, present[0]);
		}
		if (existsSync(join(current, ".git"))) return { kind: "missing" };
		const parent = dirname(current);
		if (parent === current || visited.has(parent))
			return { kind: "missing" };
		visited.add(current);
		current = parent;
	}
};

/**
 * Resolve an explicit `--config <path>`. The path is authoritative: it must exist and be a file.
 * Its editability is still analyzed (an explicit path to an unsafe config is handled by the
 * caller — failing for an explicit `--add-to-config`, or a fragment fallback otherwise).
 */
export const resolveExplicitConfig = (
	configPath: string,
	cwd: string,
): DiscoveredConfig => {
	const abs = isAbsolute(configPath) ? configPath : resolve(cwd, configPath);
	if (!existsSync(abs)) {
		throw new Error(
			`Config file not found at ${abs} (from --config ${configPath}).`,
		);
	}
	if (!statSync(abs).isFile()) {
		throw new Error(`--config path ${abs} is a directory, not a file.`);
	}
	const realPath = safeRealpath(abs);
	const root = dirname(abs);
	if (!isInside(safeRealpath(root), realPath)) {
		throw new Error(
			`--config path ${abs} is a symlink that escapes its directory; refusing to edit it.`,
		);
	}
	const source = readFileSync(abs, "utf8");
	const extension = extname(abs).slice(1).toLowerCase();
	return {
		path: abs,
		root,
		source,
		extension,
		analysis: analyzeNeonConfig(source, extension),
	};
};

/**
 * The `source` path a function's scaffold directory should carry in `neon.ts`, or `undefined`
 * when the scaffold lies outside the config's project root (auto-registration must not write an
 * escaping `../…` path, and a symlinked target that escapes the root is rejected too).
 */
export const containedSourcePath = (
	root: string,
	targetDir: string,
): string | undefined => {
	const rel = relative(resolve(root), resolve(targetDir));
	if (
		rel === "" ||
		rel === ".." ||
		rel.startsWith(`..${sep}`) ||
		isAbsolute(rel)
	) {
		return undefined;
	}
	const realRoot = safeRealpath(root);
	if (!isInside(realRoot, realpathExistingPrefix(targetDir)))
		return undefined;
	const posix = rel.split(sep).join("/");
	return `./${posix}`;
};

/** Whether two `source` paths resolve (relative to the config root) to the same directory. */
export const sameNormalizedSource = (
	root: string,
	existing: string,
	next: string,
): boolean => resolve(root, existing) === resolve(root, next);
