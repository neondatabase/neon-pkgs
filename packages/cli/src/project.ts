import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
	ConfigLoadError,
	type LoadConfigOptions,
	type LoadedConfig,
	loadConfigFromFile,
} from "@neon/config";
import { currentContextFile } from "./context.js";

/** Config filenames the runtime loads (mirrors @neon/config's loader). */
const NEON_CONFIG_FILENAMES = ["neon.ts", "neon.mts", "neon.js", "neon.mjs"];

export const neonConfigFilename = (dir: string): string | undefined =>
	NEON_CONFIG_FILENAMES.find((name) => existsSync(join(dir, name)));

/** Whether `dir` already has a Neon config file the runtime would load. */
export const hasNeonConfigFile = (dir: string): boolean =>
	neonConfigFilename(dir) !== undefined;

/**
 * Where a command finds its project. `contextFile` is the effective `--context-file` (its
 * default is the nearest `.neon` at or above cwd); callers without one fall back to that
 * walk from `cwd`.
 */
export type ProjectLocation = { cwd?: string; contextFile?: string };

/**
 * The project a command acts on: the directory holding its `.neon` (the nearest one at or
 * above cwd unless `--context-file` says otherwise), else cwd. Its `neon.ts` and default
 * `.env.local` live there and nowhere else, so a stray file in a parent directory never
 * applies.
 */
export const projectDir = ({
	cwd = process.cwd(),
	contextFile,
}: ProjectLocation = {}): string =>
	dirname(contextFile ? resolve(cwd, contextFile) : currentContextFile(cwd));

/** Absolute path of the project's `neon.ts` (or other supported extension), if any. */
export const projectConfigPath = (
	location: ProjectLocation = {},
): string | undefined => {
	const dir = projectDir(location);
	const name = neonConfigFilename(dir);
	return name === undefined ? undefined : join(dir, name);
};

/**
 * Load the project's Neon config. An explicit `path` (`--config`) wins; otherwise only
 * {@link projectDir} is checked. Callers match "Could not find a Neon config file" to tell
 * a missing config from a broken one.
 */
export const loadProjectConfig = async (
	options: ProjectLocation &
		Pick<LoadConfigOptions, "path" | "unsetFunctionEnv">,
): Promise<LoadedConfig> => {
	const { cwd, unsetFunctionEnv } = options;
	const path = options.path ?? projectConfigPath(options);
	if (path === undefined) {
		throw new ConfigLoadError(
			[
				`Could not find a Neon config file in ${projectDir(options)}.`,
				`Looked for: ${NEON_CONFIG_FILENAMES.join(", ")} next to the project's .neon (or in the current directory when there is no .neon).`,
				"Create one with `neon config init`, or pass `--config <path>`.",
			].join("\n"),
		);
	}
	return await loadConfigFromFile({
		path,
		...(cwd !== undefined ? { cwd } : {}),
		...(unsetFunctionEnv !== undefined ? { unsetFunctionEnv } : {}),
	});
};

/**
 * Substrings that mark a module-resolution failure while loading `neon.ts` —
 * almost always because the project's dependencies aren't installed yet (the
 * config imports `@neon/config` & friends). Deliberately specific:
 * the generic "…or a missing dependency…" hint the loader always appends is
 * NOT in here, so a real syntax/runtime error doesn't get mislabeled.
 */
const MISSING_DEPENDENCY_HINTS = [
	"cannot find module",
	"cannot find package",
	"err_module_not_found",
	"failed to resolve",
	"could not resolve",
	"module not found",
];

/** Flatten an error and its `cause` chain to one lowercased string for matching. */
const errorChainText = (err: unknown): string => {
	const parts: string[] = [];
	let current: unknown = err;
	for (let depth = 0; current instanceof Error && depth < 6; depth++) {
		parts.push(current.message);
		current = (current as { cause?: unknown }).cause;
	}
	return parts.join("\n").toLowerCase();
};

/** Whether loading `neon.ts` failed because a package it imports is not installed. */
export const looksLikeMissingDependency = (err: unknown): boolean => {
	const text = errorChainText(err);
	return MISSING_DEPENDENCY_HINTS.some((hint) => text.includes(hint));
};

/**
 * What to tell the user in that case. `installCommand` is the project's install
 * command (`formatInstallCommand(resolvePackageManager(dir))`).
 */
export const missingDependencyMessage = (
	installCommand: string,
	err: unknown,
): string =>
	"Could not load neon.ts: a package it imports is not installed. " +
	`Run \`${installCommand}\`, then try again.\n` +
	`Original error: ${err instanceof Error ? err.message : String(err)}`;
