import { ErrorCode, PlatformError } from "./errors.js";
import type { NeonApi } from "./neon-api.js";
import { createRealNeonApi } from "./neon-api-real.js";

/** Trim trailing slashes and surrounding whitespace; treat empty as unset. */
function normalizeApiHost(url: string | undefined): string | undefined {
	const trimmed = url?.trim().replace(/\/+$/, "");
	return trimmed ? trimmed : undefined;
}

/**
 * Build a real {@link NeonApi} adapter from an explicit API key, or throw a uniform
 * `PLATFORM_MISSING_API_KEY` error when the caller didn't supply one.
 *
 * **This function is pure with respect to its environment**: it reads no environment
 * variables and no files. Everything it needs arrives in `options`. Resolving *where* a
 * credential comes from — a flag, `NEON_API_KEY`, a credentials file on disk — is the
 * caller's job, because only the caller knows which of those its users expect. See
 * `packages/cli` (`ensureAuth` + `resolveApiKeyFromEnv`) and `packages/init`
 * (`src/lib/auth.ts`) for the two implementations in this repo.
 *
 * Used by `pullConfig`, `pushConfig`, `fetchEnv`, and `branch` to build their default
 * adapter when the caller doesn't inject one. `operation` is the calling function's name
 * (e.g. `"pushConfig"`, `"branch"`) — it's prepended to the error message so users can tell
 * which call surfaced the missing key.
 */
export function createNeonApiFromOptions(
	operation: string,
	options: {
		apiKey?: string;
		apiHost?: string;
	} = {},
): NeonApi {
	const apiKey = options.apiKey?.trim();
	if (!apiKey) {
		throw new PlatformError(
			ErrorCode.MissingApiKey,
			[
				`${operation} was not given a Neon API key.`,
				"Pass `apiKey` explicitly, or inject your own `api` adapter (e.g. an in-memory fake for tests).",
				"This package never reads NEON_API_KEY or a credentials file on your behalf — resolve the key in your own application or CLI and pass it in.",
				"Generate a key at https://console.neon.tech/app/settings/api-keys.",
			].join(" "),
		);
	}

	const baseUrl = normalizeApiHost(options.apiHost);
	return createRealNeonApi({
		apiKey,
		...(baseUrl ? { baseUrl } : {}),
	});
}
