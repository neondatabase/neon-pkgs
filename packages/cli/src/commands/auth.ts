import { createHash } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import type yargs from "yargs";

import type { NeonApiClient } from "../api.js";

import { getApiClient } from "../api.js";
import { auth, refreshToken } from "../auth.js";
import { setAuthContext } from "../auth_context.js";
import {
	credentialInputs,
	displacedProfileWarning,
	selectCredential,
} from "../auth_selection.js";
import { credentialsPath as defaultCredentialsPath } from "../config.js";
import {
	isConfigInit,
	isCurrentBranchProbe,
	isProfileCommand,
} from "../context.js";
import {
	API_KEY,
	type CredentialKind,
	interpretCredentials,
	OAUTH,
	readCredentials,
	type StoredCredentials,
	writeCredentials,
} from "../credentials.js";
import { isCi } from "../env.js";
import { log } from "../log.js";
import {
	assertValidProfileName,
	DEFAULT_PROFILE,
	newProfileCredentialsPath,
	readProfiles,
	resolveProfile,
	selectProfileName,
	upsertProfile,
} from "../profiles.js";
import type { ExtendedTokenSet } from "../types.js";
import { extendTokenSet } from "../utils/auth.js";

type AuthProps = {
	_: (string | number)[];
	configDir: string;
	oauthHost: string;
	apiHost: string;
	clientId: string;
	forceAuth?: boolean;
	"force-auth"?: boolean;
	allowUnsafeTls?: boolean;
	profile?: string;
};

/**
 * The credentials file a named profile resolves to, falling back to plain `credentials.json`
 * when the name is `DEFAULT` and nothing is declared. An unknown profile name is a hard error
 * rather than a silent write to the default file — a typo must not authenticate the wrong
 * account.
 */
export const credentialsPathForName = (
	configDir: string,
	name: string,
): string => {
	if (name === DEFAULT_PROFILE && !readProfiles(configDir))
		return defaultCredentialsPath(configDir);
	return resolveProfile(configDir, name).credentialsPath;
};

const credentialsPathFor = ({
	configDir,
	profile,
}: {
	configDir: string;
	profile?: string;
}): string => credentialsPathForName(configDir, selectProfileName(profile));

export const command = "auth";
export const aliases = ["login"];
export const describe = "Authenticate";
export const builder = (yargs: yargs.Argv) =>
	yargs.option("context-file", {
		hidden: true,
	});
export const handler = async (args: AuthProps) => {
	await authFlow(args);
};

export const authFlow = async ({
	configDir,
	oauthHost,
	clientId,
	apiHost,
	forceAuth,
	"force-auth": forceAuthKebab,
	allowUnsafeTls,
	profile,
}: AuthProps) => {
	const allowInteractiveAuth = forceAuth ?? forceAuthKebab;
	if (!allowInteractiveAuth && isCi()) {
		throw new Error("Cannot run interactive auth in CI");
	}
	const tokenSet = await auth({
		oauthHost: oauthHost,
		clientId: clientId,
		allowUnsafeTls,
	});

	// A named profile that doesn't exist yet is created here rather than erroring: `neon
	// auth --profile work` is how you make one, so it must work before there is anything
	// to look up.
	const profileName = selectProfileName(profile);
	const isNamed = profileName !== DEFAULT_PROFILE;
	if (isNamed) assertValidProfileName(profileName);
	const credentialsPath =
		isNamed && !readProfiles(configDir)?.profiles[profileName]
			? newProfileCredentialsPath(configDir, profileName)
			: credentialsPathFor({ configDir, profile });

	let identity: { id?: string; email?: string } = {};
	try {
		identity = await preserveCredentials(
			credentialsPath,
			tokenSet,
			getApiClient({
				apiKey: tokenSet.access_token || "",
				apiHost,
			}),
		);
	} catch {
		log.error("Failed to save credentials");
		return "";
	}

	if (isNamed) {
		upsertProfile(configDir, profileName, {
			credentials: credentialsPath,
			...(identity.email ? { label: identity.email } : {}),
			...(identity.id ? { userId: identity.id } : {}),
		});
		log.info('Saved profile "%s" (%s)', profileName, credentialsPath);
	}
	log.info("Auth complete");
	return tokenSet.access_token || "";
};

/**
 * Persist the token set and return the account it belongs to, so a named profile can be
 * labelled with an email. The credentials file records only `user_id` — a UUID with no
 * email — which is why identifying a stored profile offline is otherwise impossible.
 */
const preserveCredentials = async (
	path: string,
	credentials: ExtendedTokenSet,
	apiClient: NeonApiClient,
): Promise<{ id?: string; email?: string }> => {
	const {
		data: { id, email },
	} = await apiClient.getCurrentUserInfo();
	// Replace rather than merge, and declare the kind. Signing in makes this an OAuth
	// credential and nothing of a previous one is carried over: a retained API key would leave
	// the file holding two credentials, possibly for two different accounts, with a single
	// field deciding which one is live.
	const stored: StoredCredentials = {
		...(credentials as Record<string, unknown>),
		type: OAUTH,
		...(id !== undefined ? { user_id: id } : {}),
	};
	writeCredentials(path, stored);
	log.debug("Saved credentials to %s", path);
	log.debug("Credentials MD5 hash: %s", md5hash(JSON.stringify(stored)));
	return { ...(id ? { id } : {}), ...(email ? { email } : {}) };
};

/** Everything needed to use or refresh a stored credential. A subset of {@link AuthProps}. */
export type CredentialProps = {
	apiHost: string;
	oauthHost: string;
	clientId: string;
	allowUnsafeTls?: boolean;
};

const handleExistingToken = async (
	tokenSet: ExtendedTokenSet,
	props: CredentialProps,
	credentialsPath: string,
): Promise<{ apiKey: string; apiClient: NeonApiClient } | null> => {
	// Use existing access_token, if present and valid
	if (tokenSet.access_token && tokenSet.expires_at > Date.now()) {
		log.debug("Using existing valid access_token");
		const apiClient = getApiClient({
			apiKey: tokenSet.access_token,
			apiHost: props.apiHost,
		});

		return { apiKey: tokenSet.access_token, apiClient };
	}

	// Either access_token is missing or its expired. Refresh the token
	log.debug(
		tokenSet.expires_at < Date.now()
			? "Token is expired, attempting refresh"
			: "Token is missing access_token, attempting refresh",
	);

	if (!tokenSet.refresh_token) {
		log.debug("TokenSet is missing refresh_token, starting authentication");
		return null;
	}

	try {
		const refreshedTokenSet = await refreshToken(
			{
				oauthHost: props.oauthHost,
				clientId: props.clientId,
				allowUnsafeTls: props.allowUnsafeTls,
			},
			tokenSet,
		);

		// Extend the token set with expires_at
		const extendedTokenSet = extendTokenSet(refreshedTokenSet);

		const apiKey = extendedTokenSet.access_token;
		const apiClient = getApiClient({
			apiKey,
			apiHost: props.apiHost,
		});

		await preserveCredentials(credentialsPath, extendedTokenSet, apiClient);
		log.debug("Token refresh successful");

		return { apiKey, apiClient };
	} catch (err: unknown) {
		const typedErr =
			err instanceof Error ? err : new Error("Unknown error");
		log.debug("Failed to refresh token: %s", typedErr.message);
		throw new Error("AUTH_REFRESH_FAILED");
	}
};

/**
 * The credential a stored file can authenticate with right now — its API key, or an OAuth
 * access token, refreshed first when it has expired. Never launches a browser.
 *
 * The `profile` subcommands need exactly this. They deliberately skip `ensureAuth`, but
 * `rotate-key` still has to call the API as the account it is rotating, and falling through to
 * an interactive login would be authenticating something other than what the command is about.
 */
export const usableCredential = async (
	props: CredentialProps,
	credentialsPath: string,
): Promise<{ apiKey: string; kind: CredentialKind } | null> => {
	const stored = readCredentials(credentialsPath);
	if (stored === null) return null;

	// A file that declares an unusable kind throws, rather than being reported as "no
	// credential" — the user needs to know it is broken, not that it is absent.
	const credential = interpretCredentials(stored, credentialsPath);
	if (credential.kind === API_KEY) {
		return { apiKey: credential.apiKey, kind: API_KEY };
	}

	try {
		const result = await handleExistingToken(
			stored as ExtendedTokenSet,
			props,
			credentialsPath,
		);
		return result ? { apiKey: result.apiKey, kind: OAUTH } : null;
	} catch (err) {
		log.debug(
			"Could not use the stored OAuth session at %s: %s",
			credentialsPath,
			err instanceof Error ? err.message : "unknown error",
		);
		return null;
	}
};

export const ensureAuth = async (
	props: AuthProps & {
		apiKey: string;
		apiClient: NeonApiClient;
		help: boolean;
	},
) => {
	// Skip auth for help command or no command
	if (props._.length === 0 || props.help) {
		return;
	}

	// `(config) status --current-branch` is a purely-local read of `.neon`; it must
	// never refresh a token or pop a browser login. Skip auth entirely (the handler
	// doesn't use an API client in this mode).
	if (isCurrentBranchProbe(props)) {
		return;
	}

	// `config init` only scaffolds a neon.ts and installs npm packages locally; it
	// never calls the Neon API, so skip auth entirely — no token refresh, no login.
	if (isConfigInit(props)) {
		return;
	}

	// `profile` reads and edits credential files on disk. Authenticating first would mean
	// a browser login just to list profiles, and would make a lapsed profile unremovable.
	if (isProfileCommand(props)) {
		return;
	}

	// `dev` runs a function locally. It injects the selected branch's env vars
	// when credentials happen to be available, but must never trigger an
	// interactive login: use an API key or existing stored credentials if
	// present, otherwise run with no API client (env injection is skipped).
	const isLocalDev = props._[0] === "dev";

	// `bootstrap` only copies a public template repo; it never calls the Neon
	// API, so it must work without credentials and must never pop a browser
	// login. It uses an API key / stored credentials when present (harmless),
	// otherwise it proceeds with no API client.
	const isBootstrap = props._[0] === "bootstrap";

	// `init` manages its own auth flow (asks the user if they have an account,
	// then triggers OAuth at the right time). Skip the global auth middleware.
	const isInit = props._[0] === "init";

	// `auth` writes a credential rather than using one, and reads `--profile` as the
	// destination to write it to. Running selection here would reject the flag pair it
	// accepts, and could resolve a stored key that this command must not authenticate with.
	if (props._[0] === "auth") {
		props.apiClient = getApiClient({
			apiKey: props.apiKey,
			apiHost: props.apiHost,
		});
		return;
	}

	// Throws when `--api-key` and `--profile` are both passed.
	const selection = selectCredential({
		...credentialInputs(),
		profileFlag: props.profile,
	});

	const displaced = displacedProfileWarning(selection);
	if (displaced !== null) {
		log.warning(displaced);
	}

	if (selection.source !== "profile") {
		props.apiKey = selection.apiKey;
		log.debug("Using an API key to authorize requests");
		setAuthContext({
			source: "api-key",
			configDir: props.configDir,
		});
		props.apiClient = getApiClient({
			apiKey: props.apiKey,
			apiHost: props.apiHost,
		});
		return;
	}

	// An explicit `--profile` outranks an exported `NEON_API_KEY`, which the middleware has
	// already folded into `apiKey`. Clear it so nothing downstream — analytics, `dev`'s env
	// runtime, a re-exec — authenticates with a key this invocation decided against.
	props.apiKey = "";

	const credentialsPath = credentialsPathForName(
		props.configDir,
		selection.profile,
	);
	const stored = readCredentials(credentialsPath);

	if (stored !== null) {
		log.debug("Trying to read credentials from %s", credentialsPath);
		// Throws on a file whose declared kind is unusable. That is deliberate: falling
		// through to a browser login would replace the credential the user is fixing.
		const credential = interpretCredentials(stored, credentialsPath);

		if (credential.kind === API_KEY) {
			log.debug(
				'Using profile "%s"\'s API key to authorize requests',
				selection.profile,
			);
			props.apiKey = credential.apiKey;
			setAuthContext({
				source: "profile-api-key",
				configDir: props.configDir,
				profile: selection.profile,
				credentialsPath,
			});
			props.apiClient = getApiClient({
				apiKey: credential.apiKey,
				apiHost: props.apiHost,
			});
			return;
		}

		try {
			const result = await handleExistingToken(
				stored as ExtendedTokenSet,
				props,
				credentialsPath,
			);
			if (result) {
				props.apiKey = result.apiKey;
				props.apiClient = result.apiClient;
				setAuthContext({
					source: "stored-credentials",
					configDir: props.configDir,
					profile: selection.profile,
					credentialsPath,
				});
				return;
			}
		} catch (err) {
			if (
				!(err instanceof Error && err.message === "AUTH_REFRESH_FAILED")
			) {
				throw err;
			}
			// A refresh that failed is recoverable by logging in again.
			log.debug("Ensure auth failed, starting authentication", err);
		}
	} else {
		log.debug(
			"No usable credentials at %s, starting authentication",
			credentialsPath,
		);
	}

	// `dev` never launches the interactive browser flow. With no usable
	// credentials it proceeds without an API client; env injection is skipped
	// and the function still runs locally.
	if (isLocalDev) {
		log.debug("dev: no usable credentials; running without env injection");
		return;
	}

	if (isBootstrap) {
		log.debug("bootstrap: no usable credentials; continuing without auth");
		return;
	}

	if (isInit) {
		log.debug("init: skipping global auth; init manages its own auth flow");
		return;
	}

	// Start new auth flow if no valid token exists or refresh failed. Pass the resolved
	// profile rather than the raw flag, so a name that came from `NEON_PROFILE` is written to
	// its own file instead of overwriting `DEFAULT`'s.
	const apiKey = await authFlow({ ...props, profile: selection.profile });
	props.apiKey = apiKey;
	props.apiClient = getApiClient({
		apiKey,
		apiHost: props.apiHost,
	});
	setAuthContext({
		source: "stored-credentials",
		configDir: props.configDir,
		profile: selection.profile,
		credentialsPath,
	});
};

/**
 * Delete one credentials file — used by the 401 handler to clear an OAuth token set the API
 * has rejected, so the next command logs in again instead of failing the same way.
 *
 * It takes the exact path rather than a directory and an optional profile. Deriving the path
 * here meant re-running selection from partial state, and the 401 handler has no parsed
 * arguments: it passed only the config directory, so a rejected token on a
 * `--profile`-selected account deleted whatever `DEFAULT` pointed at — signing the user out
 * of an account whose credentials the failed request had never touched.
 */
export const deleteCredentialsAt = (credentialsPath: string): void => {
	try {
		if (existsSync(credentialsPath)) {
			rmSync(credentialsPath);
			log.info("Deleted credentials from %s", credentialsPath);
		} else {
			log.debug("Credentials file %s does not exist", credentialsPath);
		}
	} catch (err) {
		const typedErr =
			err instanceof Error ? err : new Error("Unknown error");
		log.error("Failed to delete credentials: %s", typedErr.message);
		throw new Error("CREDENTIALS_DELETE_FAILED");
	}
};

const md5hash = (s: string) => createHash("md5").update(s).digest("hex");
