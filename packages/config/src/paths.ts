/**
 * # `@neon/config/paths` — where the Neon CLIs keep their files on disk
 *
 * **Implementor-only, and deliberately impure.** This subpath reads environment variables
 * and touches the filesystem, which the root `@neon/config` export must never do — the same
 * split as `@neon/env` (pure) versus `@neon/env/runtime` (stateful). Import it from a CLI,
 * never from a `neon.ts` policy. It imports nothing from the rest of the package, so pulling
 * it in costs one module.
 *
 * It exists because three separate readers each grew their own answer to "where is the
 * config directory", and all three disagreed: `packages/cli` honoured `XDG_CONFIG_HOME` but
 * not `NEONCTL_CONFIG_DIR`, `packages/env` honoured the env var but not XDG, and
 * `packages/init` hardcoded `~/.config/neonctl`. With `XDG_CONFIG_HOME` set, the CLI wrote
 * credentials somewhere the other two never looked.
 *
 * ## The directory
 *
 * `neon` is the current name; `neonctl` is the legacy one, kept readable forever. Resolution,
 * each entry winning over the next:
 *
 * 1. An explicit directory (a `--config-dir` flag) — **exact**, no legacy fallback.
 * 2. `NEON_CONFIG_DIR` — exact.
 * 3. `NEONCTL_CONFIG_DIR` (legacy name) — exact.
 * 4. `$XDG_CONFIG_HOME/neon`, else `<home>/.config/neon`.
 *
 * An explicitly chosen directory is never paired with a fallback: `--config-dir /tmp/ci` that
 * quietly read `~/.config/neonctl` would defeat the point of passing it.
 *
 * ## The files
 *
 * {@link resolveConfigFile} answers "which path should I use for this file", and it is the
 * same answer for reading and writing:
 *
 * - Present in `neon/` → use it.
 * - Present only in `neonctl/` → **use it there, in place.** An existing credentials file is
 *   never copied or moved, so nothing is left behind to go stale and no other tool starts
 *   reading an abandoned token.
 * - Present in neither → the new location. New files only ever appear under `neon/`.
 */

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

/** Current directory name. New files are created here. */
export const CONFIG_DIR_NAME = "neon";

/** Legacy directory name, read forever so existing installs keep working untouched. */
export const LEGACY_CONFIG_DIR_NAME = "neonctl";

export interface ConfigPathOptions {
	/**
	 * An explicit directory, e.g. from a `--config-dir` flag. Used exactly as given: no
	 * environment variables are consulted and the legacy directory is never searched.
	 */
	dir?: string;
	/** Environment to read. Defaults to `process.env`. Injectable for tests. */
	env?: NodeJS.ProcessEnv;
}

/** Where files are created. See the module docs for the precedence. */
export function configDir(options: ConfigPathOptions = {}): string {
	const explicit = explicitDir(options);
	if (explicit) return explicit;
	return join(configHome(options.env ?? process.env), CONFIG_DIR_NAME);
}

/**
 * The legacy directory, or `undefined` when the location was chosen explicitly (in which
 * case there is no legacy counterpart to fall back to).
 */
export function legacyConfigDir(
	options: ConfigPathOptions = {},
): string | undefined {
	if (explicitDir(options)) return undefined;
	return join(configHome(options.env ?? process.env), LEGACY_CONFIG_DIR_NAME);
}

export interface ResolvedConfigFile {
	/** The path to use, for both reading and writing. */
	path: string;
	/** The directory `path` lives in. */
	dir: string;
	/** True when the file was found in the legacy `neonctl` directory. */
	isLegacy: boolean;
	/** Whether the file exists at `path` right now. */
	exists: boolean;
}

/**
 * Resolve one file inside the config directory. Prefers the current location, falls back to
 * an existing legacy file **in place**, and otherwise points at the current location so new
 * files are created there.
 */
export function resolveConfigFile(
	fileName: string,
	options: ConfigPathOptions = {},
): ResolvedConfigFile {
	const dir = configDir(options);
	const current = resolve(dir, fileName);
	if (existsSync(current))
		return { path: current, dir, isLegacy: false, exists: true };

	const legacyDir = legacyConfigDir(options);
	if (legacyDir) {
		const legacy = resolve(legacyDir, fileName);
		if (existsSync(legacy))
			return {
				path: legacy,
				dir: legacyDir,
				isLegacy: true,
				exists: true,
			};
	}

	return { path: current, dir, isLegacy: false, exists: false };
}

/** `$XDG_CONFIG_HOME`, else `<home>/.config`. Falls back to a relative `.config` with no home. */
function configHome(env: NodeJS.ProcessEnv): string {
	const xdg = nonEmpty(env.XDG_CONFIG_HOME);
	if (xdg) return xdg;
	const home = nonEmpty(env.HOME) ?? nonEmpty(env.USERPROFILE);
	return home ? join(home, ".config") : ".config";
}

function explicitDir(options: ConfigPathOptions): string | undefined {
	const env = options.env ?? process.env;
	return (
		nonEmpty(options.dir) ??
		nonEmpty(env.NEON_CONFIG_DIR) ??
		nonEmpty(env.NEONCTL_CONFIG_DIR)
	);
}

function nonEmpty(value: string | undefined): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed === "" ? undefined : trimmed;
}
