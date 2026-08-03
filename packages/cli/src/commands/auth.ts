import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type yargs from "yargs";

import type { NeonApiClient } from "../api.js";

import { getApiClient } from "../api.js";
import { auth, refreshToken } from "../auth.js";
import { setAuthContext } from "../auth_context.js";
import { credentialsPath as defaultCredentialsPath } from "../config.js";
import {
	isConfigInit,
	isCurrentBranchProbe,
	isProfileCommand,
} from "../context.js";
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
 * The credentials file this invocation reads and writes: the selected profile's, falling
 * back to plain `credentials.json` when no profile was named and none is declared. An
 * unknown profile name is a hard error rather than a silent write to the default file —
 * a typo must not authenticate the wrong account.
 */
const credentialsPathFor = ({
	configDir,
	profile,
}: {
	configDir: string;
	profile?: string;
}): string => {
	const name = selectProfileName(profile);
	if (name === DEFAULT_PROFILE && !readProfiles(configDir))
		return defaultCredentialsPath(configDir);
	return resolveProfile(configDir, name).credentialsPath;
};

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
	const contents = JSON.stringify({
		// Cast to a plain record: we intentionally spread the credentials object.
		...(credentials as Record<string, unknown>),
		user_id: id,
	});
	// Owner-only. A credentials file needs read/write, never execute.
	writeFileSync(path, contents, {
		mode: 0o600,
	});
	log.debug("Saved credentials to %s", path);
	log.debug("Credentials MD5 hash: %s", md5hash(contents));
	return { ...(id ? { id } : {}), ...(email ? { email } : {}) };
};

const handleExistingToken = async (
	tokenSet: ExtendedTokenSet,
	props: AuthProps,
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

	// Use existing API key or handle auth command
	if (props.apiKey || props._[0] === "auth") {
		if (props.apiKey) {
			log.debug("Using an API key to authorize requests");
			setAuthContext({
				source: "api-key",
				configDir: props.configDir,
			});
		}
		props.apiClient = getApiClient({
			apiKey: props.apiKey,
			apiHost: props.apiHost,
		});
		return;
	}

	const credentialsPath = credentialsPathFor(props);

	// Handle case when credentials file exists
	if (existsSync(credentialsPath)) {
		log.debug("Trying to read credentials from %s", credentialsPath);
		try {
			const contents = readFileSync(credentialsPath, "utf8");
			log.debug("Credentials MD5 hash: %s", md5hash(contents));
			const tokenSet: ExtendedTokenSet = JSON.parse(contents);

			// Try to use existing token or refresh it
			const result = await handleExistingToken(
				tokenSet,
				props,
				credentialsPath,
			);
			if (result) {
				props.apiKey = result.apiKey;
				props.apiClient = result.apiClient;
				setAuthContext({
					source: "stored-credentials",
					configDir: props.configDir,
				});
				return;
			}
		} catch (err) {
			if (
				!(
					err instanceof Error &&
					err.message === "AUTH_REFRESH_FAILED"
				) &&
				(err as { code: string }).code !== "ENOENT" &&
				!(err instanceof SyntaxError)
			) {
				// Throw for any errors except auth refresh failure, missing file, or invalid credentials file
				throw err;
			}

			// Fall through to new auth flow for auth failures
			log.debug("Ensure auth failed, starting authentication", err);
		}
	} else {
		log.debug(
			"Credentials file %s does not exist, starting authentication",
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

	// Start new auth flow if no valid token exists or refresh failed
	const apiKey = await authFlow(props);
	props.apiKey = apiKey;
	props.apiClient = getApiClient({
		apiKey,
		apiHost: props.apiHost,
	});
	setAuthContext({
		source: "stored-credentials",
		configDir: props.configDir,
	});
};

/**
 * Delete the credentials backing a profile — used by the 401 handler to clear a token the
 * API has rejected, so the next command re-authenticates instead of failing again.
 *
 * @param configDir Directory the credentials live in
 * @param profile Profile whose credentials to clear. Defaults to the selected one.
 */
export const deleteCredentials = (
	configDir: string,
	profile?: string,
): void => {
	const credentialsPath = credentialsPathFor({
		configDir,
		...(profile ? { profile } : {}),
	});
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
