import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { ErrorCode, PlatformError } from "./errors.js";
import type { NeonApi } from "./neon-api.js";
import { createRealNeonApi } from "./neon-api-real.js";

/**
 * Minimal shape of `~/.config/neonctl/credentials.json` we read. `neonctl` writes more
 * fields (refresh_token, expires_at, …) but only `access_token` is what we need — it's a
 * Bearer token the Neon API accepts on the same endpoints `napi_*` API keys do.
 */
export interface NeonctlCredentials {
	access_token: string;
	[key: string]: unknown;
}

/**
 * Locate and read the OAuth credentials neonctl writes after `neon auth`.
 *
 * Resolution:
 * 1. `options.configDir` (explicit override — mirrors neonctl's `--config-dir` flag).
 * 2. `NEONCTL_CONFIG_DIR` environment variable.
 * 3. `<home>/.config/neonctl/credentials.json` (the neonctl default).
 *
 * `home` falls back to `USERPROFILE` for Windows parity, again matching neonctl/init.
 *
 * Returns `null` (never throws) when the file is missing, unreadable, malformed, or has
 * no `access_token` — so callers can use this as a quiet fallback in a resolution chain
 * without try/catch noise.
 */
export function readNeonctlCredentials(
	options: {
		configDir?: string;
		env?: Record<string, string | undefined>;
		home?: string;
	} = {},
): NeonctlCredentials | null {
	const env = options.env ?? process.env;
	const home = options.home ?? env.HOME ?? env.USERPROFILE;
	const configDir =
		options.configDir ??
		env.NEONCTL_CONFIG_DIR ??
		(home ? resolve(home, ".config", "neonctl") : undefined);
	if (!configDir) return null;

	const credentialsPath = resolve(configDir, "credentials.json");
	if (!existsSync(credentialsPath)) return null;

	let raw: string;
	try {
		raw = readFileSync(credentialsPath, "utf-8");
	} catch {
		return null;
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return null;
	}

	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed))
		return null;
	const obj = parsed as Record<string, unknown>;
	if (typeof obj.access_token !== "string" || obj.access_token === "")
		return null;
	return obj as NeonctlCredentials;
}

/**
 * Resolution chain for the Bearer token sent to the Neon API. Each entry wins over the
 * next:
 *
 * 1. `options.apiKey` (explicit).
 * 2. `NEON_API_KEY` environment variable.
 * 3. `access_token` from `~/.config/neonctl/credentials.json` (or `NEONCTL_CONFIG_DIR`).
 *
 * Returns `null` when no source provides one. Callers wrap the null case in a
 * `PLATFORM_MISSING_API_KEY` error with a message tailored to the operation.
 */
export function resolveApiKey(
	options: {
		apiKey?: string;
		env?: Record<string, string | undefined>;
		configDir?: string;
		home?: string;
	} = {},
): { token: string; source: "option" | "env" | "neonctl" } | null {
	if (options.apiKey && options.apiKey.trim() !== "") {
		return { token: options.apiKey.trim(), source: "option" };
	}
	const env = options.env ?? process.env;
	const envKey = env.NEON_API_KEY;
	if (typeof envKey === "string" && envKey.trim() !== "") {
		return { token: envKey.trim(), source: "env" };
	}
	const creds = readNeonctlCredentials({
		...(options.configDir ? { configDir: options.configDir } : {}),
		...(options.home ? { home: options.home } : {}),
		...(options.env ? { env: options.env } : {}),
	});
	if (creds) {
		return { token: creds.access_token, source: "neonctl" };
	}
	return null;
}

/**
 * Resolve the Neon API key via the standard chain (option → `NEON_API_KEY` env →
 * `~/.config/neonctl/credentials.json`) and construct a real {@link NeonApi} adapter from
 * it, or throw a uniform `PLATFORM_MISSING_API_KEY` error if no key can be found.
 *
 * Used by `pullConfig`, `pushConfig`, `fetchEnv`, and `branch` to build their default
 * `NeonApi` when the caller doesn't inject one. `operation` is the calling function's
 * name (e.g. `"pushConfig"`, `"branch"`) — it's prepended to the error message so users
 * can tell which call surfaced the missing key.
 */
export function createNeonApiFromOptions(
	operation: string,
	options: {
		apiKey?: string;
		env?: Record<string, string | undefined>;
	} = {},
): NeonApi {
	const resolved = resolveApiKey({
		...(options.apiKey ? { apiKey: options.apiKey } : {}),
		...(options.env ? { env: options.env } : {}),
	});
	if (resolved) return createRealNeonApi({ apiKey: resolved.token });
	throw new PlatformError(
		ErrorCode.MissingApiKey,
		[
			`${operation} has no Neon API key to work with.`,
			"Tried (in order): `apiKey` option, NEON_API_KEY env, and `~/.config/neonctl/credentials.json`.",
			"Either pass `apiKey` directly, set NEON_API_KEY, run `npx neonctl auth` to populate the credentials file, or pass a custom `api` adapter (e.g. an in-memory fake for tests).",
			"Generate a key at https://console.neon.tech/app/settings/api-keys.",
		].join(" "),
	);
}
