import { selectCredential } from "../../_shared/auth_selection.js";
import {
	inspectCredentials,
	interpretCredentials,
} from "../../_shared/credentials.js";
import { configDir, resolveConfigFile } from "../../_shared/paths.js";
import { DEFAULT_PROFILE, resolveProfile } from "../../_shared/profiles.js";

/**
 * Resolve the Neon API key for a `neon-env` CLI invocation.
 *
 * Precedence is the `neon` CLI's, from the same module: **an explicit flag beats an ambient
 * environment variable.** `--api-key` and `--profile` together is an error; `--profile` beats
 * `NEON_API_KEY`; `--api-key` beats `NEON_PROFILE`; two ambient sources resolve to the key.
 *
 * Sharing that decision rather than restating it is the point. An earlier version of this file
 * checked `NEON_API_KEY` before the selected profile, so `NEON_API_KEY=… neon-env run --profile
 * work` silently used the wrong account — the very bug this feature fixes in `neon`.
 *
 * The CLI owns the resolution because `@neon/config` and `@neon/env`'s root export are
 * deliberately environment- and filesystem-agnostic: they accept an explicit `apiKey` and
 * nothing else, so the ambient sources a *user* expects have to be read out here.
 */
export function resolveApiKey(options: {
	apiKey?: string;
	profile?: string;
	env?: NodeJS.ProcessEnv;
}): string | undefined {
	const env = options.env ?? process.env;
	const selection = selectCredential({
		...(options.apiKey !== undefined ? { apiKeyFlag: options.apiKey } : {}),
		...(options.profile !== undefined
			? { profileFlag: options.profile }
			: {}),
		...(env.NEON_API_KEY !== undefined
			? { apiKeyEnv: env.NEON_API_KEY }
			: {}),
		...(env.NEON_PROFILE !== undefined
			? { profileEnv: env.NEON_PROFILE }
			: {}),
	});

	if (selection.source !== "profile") return selection.apiKey;
	return readStoredCredential(selection, env);
}

/**
 * The credential stored for the selected profile.
 *
 * An **explicitly** named profile that cannot be used is an error: the user said which account to
 * act as, and falling through to "no API key" would report a missing credential when the real
 * problem is the name they typed. `DEFAULT` is different — nothing was named, so having no
 * credential there is the ordinary not-signed-in case and the library's
 * `PLATFORM_MISSING_API_KEY` says it better than a stack trace.
 */
function readStoredCredential(
	selection: { profile: string; explicit: boolean },
	env: NodeJS.ProcessEnv,
): string | undefined {
	const { profile, explicit } = selection;
	const fail = (reason: string): undefined => {
		if (explicit) throw new Error(reason);
		return undefined;
	};

	let path: string;
	try {
		path =
			profile === DEFAULT_PROFILE
				? // Per *file*, so an install predating the rename still finds its
					// `credentials.json` in the legacy `neonctl` directory, in place.
					resolveConfigFile("credentials.json", { env }).path
				: // From the config root, not from wherever `credentials.json` happens to live:
					// that file can still be in `neonctl/` while `profiles.json` is in `neon/`,
					// and deriving one from the other loses every named profile.
					resolveProfile(configDir({ env }), profile).credentialsPath;
	} catch (err) {
		return fail(err instanceof Error ? err.message : String(err));
	}

	const read = inspectCredentials(path);
	if (read.kind === "absent") {
		return fail(
			`Profile "${profile}" has no stored credential at ${path}. Sign in with \`neon profile create ${profile}\`.`,
		);
	}
	if (read.kind === "unusable") return fail(read.reason);

	try {
		const credential = interpretCredentials(read.credentials, path);
		if (credential.kind === "api_key") return credential.apiKey;
		const token = read.credentials.access_token;
		return typeof token === "string" && token.trim() !== ""
			? token.trim()
			: fail(
					`Profile "${profile}" holds a browser sign-in with no usable token. Sign in again with \`neon auth --profile ${profile}\`.`,
				);
	} catch (err) {
		return fail(err instanceof Error ? err.message : String(err));
	}
}

export { DEFAULT_PROFILE };
