import {
	displacedProfileWarning,
	selectCredential,
} from "@neon-internals/cli-core/auth_selection";
import { createCredentialStore } from "@neon-internals/cli-core/credential_store";
import {
	type CredentialLocation,
	credentialLabel,
	interpretCredentials,
} from "@neon-internals/cli-core/credentials";
import { configDir, resolveConfigFile } from "@neon-internals/cli-core/paths";
import {
	DEFAULT_PROFILE,
	locationForName,
	readProfiles,
} from "@neon-internals/cli-core/profiles";
import { tryLoadKeyring } from "./keyring.js";

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
	/** Where to say that an exported key displaced an exported profile. Defaults to stderr. */
	warn?: (message: string) => void;
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

	// Sharing the decision is only half of it. The disclosure is the half that keeps a
	// displaced profile from being the original bug in a quieter form: `NEON_API_KEY=…
	// NEON_PROFILE=work neon-env run` legitimately uses the key, and saying nothing leaves the
	// user believing they ran as `work`. `neon` has warned here from the start; this did not.
	const displaced = displacedProfileWarning(selection);
	if (displaced !== null) {
		const warn =
			options.warn ??
			((message: string) => process.stderr.write(`${message}\n`));
		warn(displaced);
	}

	if (selection.source !== "profile") return selection.apiKey;
	return readStoredCredential(selection, env);
}

/**
 * The credential stored for the selected profile.
 *
 * Two different situations, deliberately not merged. A **missing** credential under `DEFAULT` is
 * the ordinary not-signed-in state and resolves to no key; under a profile the user named it is
 * an error, because reporting a missing credential would hide that the real problem is the name
 * they typed. A **damaged** credential is always an error: the file is there, it is not an
 * absence, and no amount of signing in elsewhere explains it.
 */
function readStoredCredential(
	selection: { profile: string; explicit: boolean },
	env: NodeJS.ProcessEnv,
): string | undefined {
	const { profile, explicit } = selection;
	/**
	 * An *absence* is only an error when the user named the profile. Not being signed in under
	 * `DEFAULT` is the ordinary state, and the library's `PLATFORM_MISSING_API_KEY` says it
	 * better than a stack trace.
	 */
	const absent = (reason: string): undefined => {
		if (explicit) throw new Error(reason);
		return undefined;
	};

	const dir = configDir({ env });
	let at: CredentialLocation;
	try {
		at = locationForName(dir, profile);
	} catch (err) {
		// An unknown profile name is a naming error whoever typed it can fix, so it is fatal
		// either way — it cannot be reported as "not signed in".
		throw err instanceof Error ? err : new Error(String(err));
	}
	// The new config root would miss DEFAULT credentials left in legacy `neonctl/` installs.
	if (
		at.storage === "file" &&
		profile === DEFAULT_PROFILE &&
		readProfiles(dir)?.profiles[DEFAULT_PROFILE] === undefined
	) {
		at = {
			...at,
			path: resolveConfigFile("credentials.json", { env }).path,
		};
	}

	const store = createCredentialStore(configDir({ env }), {
		keyring: tryLoadKeyring(),
	});
	const loaded = store.read(at);
	if (loaded === null) {
		return absent(
			`Profile "${profile}" has no stored credential at ${credentialLabel(at)}. Sign in with \`neon profile create ${profile}\`.`,
		);
	}

	const credential = interpretCredentials(
		loaded.credentials,
		at,
		loaded.backend,
	);
	if (credential.kind === "api_key") return credential.apiKey;
	const token = loaded.credentials.access_token;
	if (typeof token === "string" && token.trim() !== "") return token.trim();
	throw new Error(
		`Profile "${profile}" holds a browser sign-in with no usable token at ${credentialLabel(at)}. Sign in again with \`neon auth --profile ${profile}\`.`,
	);
}

export { DEFAULT_PROFILE };
