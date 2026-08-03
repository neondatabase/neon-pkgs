import { existsSync, mkdirSync } from "node:fs";
import { configDir, resolveConfigFile } from "@neon/config/paths";
import type yargs from "yargs";

import { isCi } from "./env.js";

export const CREDENTIALS_FILE = "credentials.json";

/**
 * Default for `--config-dir`: `$XDG_CONFIG_HOME/neon`, else `~/.config/neon`.
 *
 * The directory was called `neonctl` until the CLI was renamed. An existing one is still
 * read — see {@link credentialsPath} — but it is never written to, moved, or deleted.
 */
export const defaultDir = configDir();

/**
 * Where this invocation's `credentials.json` lives.
 *
 * When `--config-dir` was left at its default, an existing file in the legacy `neonctl`
 * directory is used **in place**: an install that predates the rename keeps working, and
 * its credentials are never duplicated into a second location where one copy could go
 * stale while another tool still reads it.
 *
 * A `--config-dir` the user actually passed is used exactly as given. Falling back out of
 * an explicitly chosen directory would defeat the reason for choosing it — a CI run
 * pointed at a scratch directory must never pick up a developer's real credentials.
 */
export const credentialsPath = (dir: string): string =>
	resolveConfigFile(CREDENTIALS_FILE, dir === defaultDir ? {} : { dir }).path;

export const ensureConfigDir = ({
	"config-dir": configDirArg,
	"force-auth": forceAuth,
}: yargs.Arguments<{ "config-dir": string }>) => {
	if (!existsSync(configDirArg) && (!isCi() || forceAuth)) {
		mkdirSync(configDirArg, { recursive: true });
	}
};
