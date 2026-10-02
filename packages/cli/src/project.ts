import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
	type Config,
	ConfigLoadError,
	type LoadConfigOptions,
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
): Promise<{ config: Config; resolvedPath: string }> => {
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
