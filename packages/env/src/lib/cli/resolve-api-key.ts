import {
	inspectCredentials,
	interpretCredentials,
} from "../../_shared/credentials.js";
import { resolveConfigFile } from "../../_shared/paths.js";
import {
	DEFAULT_PROFILE,
	resolveProfile,
	selectProfileName,
} from "../../_shared/profiles.js";

/**
 * Resolve the Neon API key for a `neon-env` CLI invocation. Precedence (each wins over the
 * next): `--api-key` flag → `NEON_API_KEY` → the credential stored for the selected profile.
 *
 * The CLI owns this resolution — `@neon/config` and `@neon/env` are deliberately environment-
 * and filesystem-agnostic and only ever accept an explicit `apiKey`, so the ambient sources a
 * *user* expects have to be read here. This mirrors `resolveContext`, which does the same for
 * project and branch.
 *
 * Returns `undefined` rather than throwing when nothing provides a key: the caller passes it
 * straight through, and the library raises the uniform `PLATFORM_MISSING_API_KEY` error.
 */
export function resolveApiKey(options: {
	apiKey?: string;
	profile?: string;
	env?: NodeJS.ProcessEnv;
}): string | undefined {
	const env = options.env ?? process.env;
	return (
		nonEmpty(options.apiKey) ??
		nonEmpty(env.NEON_API_KEY) ??
		readStoredCredential(options.profile, env)
	);
}

/**
 * The credential stored for the selected profile — `--profile`, else `NEON_PROFILE`, else
 * `DEFAULT`.
 *
 * Reading only `DEFAULT`, as this used to, meant `neon --profile dbx env` and `neon-env` could
 * resolve different accounts on the same machine. Sharing the profile reader with the `neon` CLI
 * is what makes them agree; see `shared/cli-core/README.md`.
 *
 * The stored credential is one of two kinds, and `type` says which: an `api_key` file
 * authenticates with its `api_key`, and an OAuth file's `access_token` is itself a bearer token
 * for the Neon API.
 *
 * Never throws: a missing, unreadable, malformed or credential-less file is simply "no key", and
 * an unknown profile is "no key" too — `neon-env` has no way to report it usefully, and the
 * library's `PLATFORM_MISSING_API_KEY` says the same thing more clearly than a stack trace.
 */
function readStoredCredential(
	profile: string | undefined,
	env: NodeJS.ProcessEnv,
): string | undefined {
	const path = credentialsPathFor(profile, env);
	if (path === undefined) return undefined;

	const read = inspectCredentials(path);
	if (read.kind !== "ok") return undefined;

	try {
		const credential = interpretCredentials(read.credentials, path);
		return credential.kind === "api_key"
			? credential.apiKey
			: nonEmpty(read.credentials.access_token);
	} catch {
		return undefined;
	}
}

function credentialsPathFor(
	profile: string | undefined,
	env: NodeJS.ProcessEnv,
): string | undefined {
	// `configDir` is not passed here: `neon-env` has no `--config-dir`, so the default
	// resolution — including an existing legacy `neonctl` directory — is the only one that
	// applies, and it is the same one `@neon/config/paths` gives every other reader.
	const { dir } = resolveConfigFile("credentials.json", { env });
	const name = selectProfileName(profile, env);
	if (name === DEFAULT_PROFILE) {
		return resolveConfigFile("credentials.json", { env }).path;
	}
	try {
		return resolveProfile(dir, name).credentialsPath;
	} catch {
		return undefined;
	}
}

function nonEmpty(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed === "" ? undefined : trimmed;
}
