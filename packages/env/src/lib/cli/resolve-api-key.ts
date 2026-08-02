import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Resolve the Neon API key for a `neon-env` CLI invocation. Precedence (each wins over the
 * next): `--api-key` flag → `NEON_API_KEY` → `access_token` from the Neon CLI's
 * `credentials.json`.
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
 * Read `access_token` from the Neon CLI's credentials file, the same location and
 * precedence `neon auth` writes to: `NEONCTL_CONFIG_DIR` → `<home>/.config/neonctl`
 * (`HOME`, falling back to `USERPROFILE` for Windows parity).
 *
 * Never throws — a missing, unreadable, malformed, or token-less file is simply "no key",
 * so this can sit in a resolution chain without try/catch noise.
 */
function readStoredAccessToken(env: NodeJS.ProcessEnv): string | undefined {
	const home = env.HOME ?? env.USERPROFILE;
	const configDir =
		nonEmpty(env.NEONCTL_CONFIG_DIR) ??
		(home ? resolve(home, ".config", "neonctl") : undefined);
	if (!configDir) return undefined;

	const credentialsPath = resolve(configDir, "credentials.json");
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
