import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
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
 * The project a command acts on: the directory holding the nearest `.neon` at or above
 * `cwd`, else `cwd`. Its `neon.ts` and `.env.local` live there and nowhere else, so a
 * stray file in a parent directory never applies.
 */
export const projectDir = (cwd: string = process.cwd()): string =>
	dirname(currentContextFile(cwd));

/** Absolute path of the project's `neon.ts` (or other supported extension), if any. */
export const projectConfigPath = (
	cwd: string = process.cwd(),
): string | undefined => {
	const dir = projectDir(cwd);
	const name = neonConfigFilename(dir);
	return name === undefined ? undefined : join(dir, name);
};

/**
 * Load the project's Neon config. An explicit `path` (`--config`) wins; otherwise only
 * {@link projectDir} is checked. Callers match "Could not find a Neon config file" to tell
 * a missing config from a broken one.
 */
export const loadProjectConfig = async (
	options: Pick<LoadConfigOptions, "path" | "cwd" | "unsetFunctionEnv">,
): Promise<{ config: Config; resolvedPath: string }> => {
	const { cwd, unsetFunctionEnv } = options;
	const path = options.path ?? projectConfigPath(cwd);
	if (path === undefined) {
		throw new ConfigLoadError(
			[
				`Could not find a Neon config file in ${projectDir(cwd)}.`,
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
