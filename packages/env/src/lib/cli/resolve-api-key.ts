import { existsSync, readFileSync } from "node:fs";
import { resolveConfigFile } from "@neon/config/paths";

/**
 * Resolve the Neon API key for a `neon-env` CLI invocation. Precedence (each wins over the
 * next): `--api-key` flag → `NEON_API_KEY` → `access_token` from the Neon CLI's
 * `credentials.json`, located by `@neon/config/paths`.
 *
 * The CLI owns this resolution — `@neon/config` and `@neon/env` are deliberately
 * environment- and filesystem-agnostic and only ever accept an explicit `apiKey`, so the
 * ambient sources a *user* expects have to be read here. This mirrors `resolveContext`,
 * which does the same for project and branch.
 *
 * Returns `undefined` rather than throwing when nothing provides a key: the caller passes
 * it straight through, and the library raises the uniform `PLATFORM_MISSING_API_KEY` error.
 */
export function resolveApiKey(options: {
	apiKey?: string;
	env?: NodeJS.ProcessEnv;
}): string | undefined {
	const env = options.env ?? process.env;
	return (
		nonEmpty(options.apiKey) ??
		nonEmpty(env.NEON_API_KEY) ??
		readStoredAccessToken(env)
	);
}

/**
 * Read `access_token` from the Neon CLI's credentials file.
 *
 * Location resolution is delegated to `@neon/config/paths` so this agrees with the `neon`
 * CLI itself — `NEON_CONFIG_DIR` / `NEONCTL_CONFIG_DIR`, else `$XDG_CONFIG_HOME/neon`, else
 * `~/.config/neon`, with an existing legacy `neonctl` directory still read. Rolling that
 * lookup by hand here is how the two drifted in the first place: this file honoured the env
 * var but not XDG, while the CLI honoured XDG but not the env var, so with
 * `XDG_CONFIG_HOME` set they disagreed about where credentials lived.
 *
 * Reads only `DEFAULT` — a profile is a CLI-invocation concept, and `neon-env` has no
 * `--profile` of its own to read one from.
 *
 * Never throws: a missing, unreadable, malformed, or token-less file is simply "no key",
 * so this can sit in a resolution chain without try/catch noise.
 */
function readStoredAccessToken(env: NodeJS.ProcessEnv): string | undefined {
	const { path: credentialsPath } = resolveConfigFile("credentials.json", {
		env,
	});
	if (!existsSync(credentialsPath)) return undefined;

	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(credentialsPath, "utf-8"));
	} catch {
		return undefined;
	}

	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
		return undefined;
	return nonEmpty((parsed as Record<string, unknown>).access_token as string);
}

function nonEmpty(value: string | undefined): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed === "" ? undefined : trimmed;
}
