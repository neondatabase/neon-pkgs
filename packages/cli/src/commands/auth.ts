import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import {
	credentialInputs,
	displacedProfileWarning,
	selectCredential,
} from "@neon-internals/cli-core/auth_selection";
import {
	API_KEY,
	type CredentialKind,
	type CredentialLocation,
	credentialLabel,
	interpretCredentials,
	OAUTH,
	type StoredCredentials,
} from "@neon-internals/cli-core/credentials";
import { isOwnedCredentialPath } from "@neon-internals/cli-core/paths";
import {
	assertProfilesUsable,
	assertValidProfileName,
	DEFAULT_PROFILE,
	isKeyringPointer,
	KEYRING_CREDENTIALS,
	locationForName,
	locationOf,
	newProfileLocation,
	profilesUsingPath,
	readProfiles,
	resolveProfile,
	selectProfileName,
	upsertProfile,
} from "@neon-internals/cli-core/profiles";
import type yargs from "yargs";
import type { NeonApiClient } from "../api.js";
import { getApiClient, isNeonApiError } from "../api.js";
import {
	AuthRefreshError,
	auth,
	classifyRefreshFailure,
	refreshToken,
} from "../auth.js";
import { setAuthContext } from "../auth_context.js";
import { ClaimableClient, ClaimableServiceError } from "../claimable/api.js";
import {
	assertionHasExpired,
	claimableCredentialsPath,
	readClaimableCredentials,
	resolveClaimableContext,
	shouldUseClaimableCredentials,
} from "../claimable/state.js";
import {
	currentContextFile,
	isAskCommand,
	isClaimCommand,
	isConfigInit,
	isCurrentBranchProbe,
	isMcpCommand,
	isMcpOauth,
	isPluginsCommand,
	isProfileCommand,
	isSkillsCommand,
	readContextFile,
} from "../context.js";
import { storeFor } from "../credential_io.js";
import { isCi } from "../env.js";
import { log } from "../log.js";
import { withExclusiveLock } from "../refresh_lock.js";
import {
	type OutgoingCredential,
	readOutgoingCredential,
	retirePreviousCredential,
} from "../retire_credential.js";
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
	keyring?: boolean;
	contextFile?: string | ((cwd?: string) => string);
};

export const locationForAuth = (
	configDir: string,
	name: string,
	keyring?: boolean,
	options: { create?: boolean } = {},
): CredentialLocation => {
	const declared = readProfiles(configDir, log.warning)?.profiles[name];
	const pointer =
		declared !== undefined && isKeyringPointer(declared.credentials);
	if (keyring === true || pointer) {
		return { profile: name, storage: "keyring" };
	}
	if (declared !== undefined || name === DEFAULT_PROFILE) {
		return locationForName(configDir, name);
	}
	if (options.create === true) {
		return newProfileLocation(configDir, name, "file");
	}
	return locationForName(configDir, name);
};

export const command = "auth";
export const aliases = ["login"];
export const describe = "Authenticate";
export const builder = (yargs: yargs.Argv) =>
	yargs
		.option("context-file", {
			hidden: true,
		})
		.option("keyring", {
			describe:
				"Store the credential in the OS keyring. Per profile; later auth without the flag stays there. See `neon profile list`.",
			type: "boolean",
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
	keyring,
}: AuthProps) => {
	// A named profile that doesn't exist yet is created here rather than erroring: `neon
	// auth --profile work` is how you make one, so it must work before there is anything
	// to look up.
	const profileName = selectProfileName(profile);
	const isNamed = profileName !== DEFAULT_PROFILE;
	if (isNamed) assertValidProfileName(profileName);
	// Validate profiles first so later errors do not hide a wrong write target.
	assertProfilesUsable(configDir, profileName);
	const at = locationForAuth(configDir, profileName, keyring, {
		create: true,
	});
	if (at.storage === "keyring") {
		const declared = readProfiles(configDir)?.profiles[profileName];
		storeFor(configDir).assertKeyringWritable(
			declared !== undefined && isKeyringPointer(declared.credentials)
				? profileName
				: undefined,
		);
	}

	const allowInteractiveAuth = forceAuth ?? forceAuthKebab;
	if (!allowInteractiveAuth && isCi()) {
		throw new Error("Cannot run interactive auth in CI");
	}

	let previousFile: string | undefined;
	let previousWasKeyring = false;
	let previousOutgoing: OutgoingCredential | null = null;
	try {
		const previous = resolveProfile(configDir, profileName);
		previousWasKeyring = previous.storage === "keyring";
		if (previous.storage === "file")
			previousFile = previous.credentialsPath;
		previousOutgoing = readOutgoingCredential(
			configDir,
			locationOf(previous),
		);
	} catch {
		previousFile = undefined;
	}

	const tokenSet = await auth({
		oauthHost: oauthHost,
		clientId: clientId,
		allowUnsafeTls,
	});

	let identity: { id?: string; email?: string } = {};
	try {
		identity = await persistNewSession(
			at,
			tokenSet,
			getApiClient({
				apiKey: tokenSet.access_token || "",
				apiHost,
			}),
			configDir,
		);
	} catch (err) {
		log.error("Failed to save credentials");
		throw err instanceof Error ? err : new Error(String(err));
	}

	if (at.storage === "keyring" || isNamed) {
		try {
			upsertProfile(configDir, profileName, {
				credentials:
					at.storage === "keyring" ? KEYRING_CREDENTIALS : at.path,
				...(identity.email ? { label: identity.email } : {}),
				...(identity.id ? { userId: identity.id } : {}),
			});
		} catch (err) {
			if (at.storage === "keyring" && !previousWasKeyring) {
				const cleared = storeFor(configDir).delete(at, {
					required: false,
				});
				if (cleared !== "cleared") {
					log.warning(
						'Could not confirm the new OS keyring item for profile "%s" was removed after a failed save.',
						profileName,
					);
				}
			}
			log.error("Failed to save credentials");
			throw err instanceof Error ? err : new Error(String(err));
		}
		if (at.storage === "keyring") {
			await retirePreviousCredential(
				{
					apiHost,
					oauthHost,
					clientId,
					...(allowUnsafeTls ? { allowUnsafeTls } : {}),
				},
				profileName,
				previousOutgoing,
			);
		}
		if (
			at.storage === "keyring" &&
			previousFile !== undefined &&
			profilesUsingPath(configDir, previousFile, profileName).length === 0
		) {
			if (isOwnedCredentialPath(configDir, previousFile)) {
				try {
					storeFor(configDir).delete({
						profile: profileName,
						storage: "file",
						path: previousFile,
					});
					log.info("Deleted %s", previousFile);
				} catch {
					log.warning(
						"Saved the keyring item but could not delete %s",
						previousFile,
					);
				}
			} else if (existsSync(previousFile)) {
				log.info("Left %s on disk — not created by neon", previousFile);
			}
		}
		log.info(
			'Saved profile "%s" (%s)',
			profileName,
			at.storage === "keyring" ? KEYRING_CREDENTIALS : at.path,
		);
	}
	log.info("Auth complete");
	return tokenSet.access_token || "";
};

/**
 * Persist before identity lookup so a lookup failure cannot discard the new session.
 * Merge the identity only while that session remains current on disk.
 */
const persistNewSession = async (
	at: CredentialLocation,
	credentials: ExtendedTokenSet,
	apiClient: NeonApiClient,
	configDir: string,
): Promise<{ id?: string; email?: string }> => {
	const stored = oauthCredentialsFromTokenSet(credentials, null);
	writeOAuthCredentials(configDir, at, stored);
	const identity = await fetchIdentity(apiClient);
	if (identity.id) {
		const current = storeFor(configDir).read(at);
		if (
			current !== null &&
			current.credentials.access_token === stored.access_token
		) {
			writeOAuthCredentials(configDir, at, {
				...current.credentials,
				user_id: identity.id,
			});
		}
	}
	return identity;
};

const fetchIdentity = async (
	apiClient: NeonApiClient,
): Promise<{ id?: string; email?: string }> => {
	try {
		const {
			data: { id, email },
		} = await apiClient.getCurrentUserInfo();
		return { ...(id ? { id } : {}), ...(email ? { email } : {}) };
	} catch (err) {
		if (isNeonApiError(err) && err.status === 401) {
			throw new Error(
				"Signed in, but the Neon API rejected the new access token. Try `neon auth` again.",
			);
		}
		log.warning(
			"Signed in, but could not look up the account: %s",
			err instanceof Error ? err.message : String(err),
		);
		return {};
	}
};

/** Everything needed to use or refresh a stored credential. A subset of {@link AuthProps}. */
export type CredentialProps = {
	apiHost: string;
	oauthHost: string;
	clientId: string;
	allowUnsafeTls?: boolean;
};

export const isAccessTokenUsable = (
	credentials: StoredCredentials,
	now: number,
): boolean => {
	const token = credentials.access_token;
	if (typeof token !== "string" || token === "") return false;
	const expiresAt = credentials.expires_at;
	if (typeof expiresAt !== "number" || !Number.isFinite(expiresAt)) {
		return false;
	}
	return expiresAt > now;
};

type ResolvedAuth = {
	apiKey: string;
	apiClient: NeonApiClient;
	refreshed: boolean;
};

const handleExistingToken = async (
	tokenSet: StoredCredentials,
	props: CredentialProps & { configDir: string },
	at: CredentialLocation,
): Promise<ResolvedAuth | null> => {
	if (isAccessTokenUsable(tokenSet, Date.now())) {
		log.debug("Using existing valid access_token");
		const apiKey = tokenSet.access_token ?? "";
		return {
			apiKey,
			apiClient: getApiClient({
				apiKey,
				apiHost: props.apiHost,
			}),
			refreshed: false,
		};
	}

	if (
		typeof tokenSet.refresh_token !== "string" ||
		tokenSet.refresh_token === ""
	) {
		log.debug("Stored credentials hold no refresh_token");
		return null;
	}

	log.debug("Access token is missing or expired, attempting refresh");
	const next = await performRefresh(tokenSet, props, at);
	const apiKey = next.credentials.access_token ?? "";
	return {
		apiKey,
		apiClient: getApiClient({
			apiKey,
			apiHost: props.apiHost,
		}),
		refreshed: next.rotated,
	};
};

/**
 * Serialize exchanges because presenting a one-time refresh token twice can revoke
 * the newly issued token family. Persist immediately because the presented token is
 * invalid once the server answers.
 */
const performRefresh = async (
	credentials: StoredCredentials,
	props: CredentialProps & { configDir: string },
	at: CredentialLocation,
): Promise<{ credentials: StoredCredentials; rotated: boolean }> => {
	return await withExclusiveLock(
		refreshLockPath(props.configDir, at),
		async () => {
			const loaded = storeFor(props.configDir).read(at);
			const current = loaded?.credentials ?? credentials;
			// A later expiry is not a live session: the API may already have
			// rejected this access token. Only a different usable token means
			// another process finished the rotation.
			if (
				loaded !== null &&
				isAccessTokenUsable(current, Date.now()) &&
				current.access_token !== credentials.access_token
			) {
				log.debug(
					"Refresh lost a race; adopting the credentials another command wrote",
				);
				return { credentials: current, rotated: false };
			}

			let refreshed: ExtendedTokenSet;
			try {
				refreshed = extendTokenSet(
					await refreshToken(
						{
							oauthHost: props.oauthHost,
							clientId: props.clientId,
							allowUnsafeTls: props.allowUnsafeTls,
						},
						current,
					),
				);
			} catch (err) {
				throw err instanceof AuthRefreshError
					? err
					: classifyRefreshFailure(err);
			}

			const next = oauthCredentialsFromTokenSet(
				refreshed,
				loaded?.credentials ?? credentials,
			);
			writeOAuthCredentials(props.configDir, at, next);
			log.debug("Token refresh successful");
			return { credentials: next, rotated: true };
		},
	);
};

/** A 401 proves the access token is stale even before `expires_at`. */
export const refreshStoredCredentials = async (
	at: CredentialLocation,
	props: CredentialProps & { configDir: string },
): Promise<boolean> => {
	const loaded = storeFor(props.configDir).read(at);
	if (loaded === null) return false;
	const credential = interpretCredentials(
		loaded.credentials,
		at,
		loaded.backend,
	);
	if (credential.kind === API_KEY) return false;
	if (
		typeof loaded.credentials.refresh_token !== "string" ||
		loaded.credentials.refresh_token === ""
	) {
		return false;
	}
	await performRefresh(loaded.credentials, props, at);
	return true;
};

const oauthCredentialsFromTokenSet = (
	tokenSet: ExtendedTokenSet,
	previous: StoredCredentials | null,
): StoredCredentials => {
	const refreshTokenValue =
		typeof tokenSet.refresh_token === "string" &&
		tokenSet.refresh_token !== ""
			? tokenSet.refresh_token
			: previous?.refresh_token;
	const stored: StoredCredentials = {
		...tokenSet,
		type: OAUTH,
		expires_at: tokenSet.expires_at,
		...(typeof refreshTokenValue === "string" && refreshTokenValue !== ""
			? { refresh_token: refreshTokenValue }
			: {}),
	};
	if (previous?.user_id !== undefined) {
		stored.user_id = previous.user_id;
	}
	return stored;
};

const writeOAuthCredentials = (
	configDir: string,
	at: CredentialLocation,
	credentials: StoredCredentials,
): void => {
	storeFor(configDir).write(at, credentials);
	log.debug("Saved credentials to %s", credentialLabel(at));
	log.debug("Credentials MD5 hash: %s", md5hash(JSON.stringify(credentials)));
};

const refreshLockPath = (configDir: string, at: CredentialLocation): string => {
	const id = createHash("sha256")
		.update(credentialLabel(at))
		.digest("hex")
		.slice(0, 16);
	return join(configDir, `.refresh-${id}.lock`);
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
	props: CredentialProps & { configDir: string },
	at: CredentialLocation,
): Promise<{ apiKey: string; kind: CredentialKind } | null> => {
	const loaded = storeFor(props.configDir).read(at);
	if (loaded === null) return null;

	// A file that declares an unusable kind throws, rather than being reported as "no
	// credential" — the user needs to know it is broken, not that it is absent.
	const credential = interpretCredentials(
		loaded.credentials,
		at,
		loaded.backend,
	);
	if (credential.kind === API_KEY) {
		return { apiKey: credential.apiKey, kind: API_KEY };
	}

	try {
		const result = await handleExistingToken(loaded.credentials, props, at);
		return result ? { apiKey: result.apiKey, kind: OAUTH } : null;
	} catch (err) {
		log.debug(
			"Could not use the stored OAuth session at %s: %s",
			credentialLabel(at),
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

	if (isMcpOauth(props)) {
		return;
	}

	// `open` only reads the linked project from `.neon` and launches its Console URL.
	if (props._[0] === "open") {
		return;
	}

	// Neon authentication is unrelated to the child skills and plugins CLIs.
	if (isSkillsCommand(props) || isPluginsCommand(props)) {
		return;
	}

	if (isAskCommand(props)) {
		return;
	}

	if (props._[0] === "init") {
		// Init delegates authentication to children but must reject conflicting credential flags itself.
		selectCredential({
			...credentialInputs(),
			profileFlag: props.profile,
		});
		log.debug("init: skipping global auth; child commands authenticate");
		return;
	}

	// Claim commands exchange their own assertion, so account auth must not open first.
	if (isClaimCommand(props)) {
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

	// The MCP handler validates targets before deciding whether authentication is required.
	const isMcp = isMcpCommand(props);

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

	const inputs = credentialInputs();
	const contextFile =
		typeof props.contextFile === "function"
			? props.contextFile()
			: (props.contextFile ?? currentContextFile());
	const localContext = readContextFile(contextFile);
	if (shouldUseClaimableCredentials(inputs, props.profile, localContext)) {
		const linked = resolveClaimableContext(localContext);
		if (linked === null) {
			throw new Error(
				"The linked Claimable Neon context could not be resolved.",
			);
		}
		const stored = readClaimableCredentials(
			props.configDir,
			linked.projectId,
		);
		const path = claimableCredentialsPath(
			props.configDir,
			linked.projectId,
		);
		if (stored === null) {
			throw new Error(
				`The linked project is claimable, but its identity assertion is missing from ${path}. Run \`neon claim create\` in a new directory, or \`neon link\` after claiming the project.`,
			);
		}
		if (assertionHasExpired(stored)) {
			throw new Error(
				`The identity assertion for ${linked.projectId} has expired. Run \`neon claim delete ${linked.projectId} --yes\` to drop the local record.`,
			);
		}
		const client = new ClaimableClient(stored.origin);
		if (client.origin !== new ClaimableClient(linked.origin).origin) {
			throw new Error(
				`The linked .neon file and ${path} name different Claimable Neon services. Delete .neon or the assertion file and run \`neon claim create\` in a new directory.`,
			);
		}
		let token;
		try {
			token = await client.exchange(stored.identityAssertion);
		} catch (error) {
			if (
				error instanceof ClaimableServiceError &&
				error.code === "project_claimed"
			) {
				throw new Error(
					"This project was claimed. Run `neon claim status` to drop the local assertion, then `neon auth` or `neon link`.",
				);
			}
			throw error;
		}
		props.apiKey = token.accessToken;
		props.apiHost = `${client.origin}/v1`;
		props.apiClient = getApiClient({
			apiKey: token.accessToken,
			apiHost: props.apiHost,
		});
		setAuthContext({
			source: "claimable",
			configDir: props.configDir,
			credentialsPath: path,
		});
		log.debug(
			"Using the linked Claimable Neon project's short-lived access token",
		);
		return;
	}

	if (localContext.claimable !== undefined) {
		log.warning(
			"This directory is linked to a claimable project, but NEON_API_KEY or NEON_PROFILE is set. This command will use that account credential instead of the unclaimed project. Unset them to keep using the unclaimed project.",
		);
	}

	// Throws when `--api-key` and `--profile` are both passed.
	const selection = selectCredential({
		...inputs,
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

	const at = locationForAuth(props.configDir, selection.profile);
	const loaded = storeFor(props.configDir).read(at);

	if (loaded !== null) {
		log.debug("Trying to read credentials from %s", credentialLabel(at));
		// Throws on a file whose declared kind is unusable. That is deliberate: falling
		// through to a browser login would replace the credential the user is fixing.
		const credential = interpretCredentials(
			loaded.credentials,
			at,
			loaded.backend,
		);

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
				storage: at.storage,
				...(at.storage === "file" ? { credentialsPath: at.path } : {}),
			});
			props.apiClient = getApiClient({
				apiKey: credential.apiKey,
				apiHost: props.apiHost,
			});
			return;
		}

		try {
			setAuthContext({
				source: "stored-credentials",
				configDir: props.configDir,
				profile: selection.profile,
				storage: at.storage,
				accessToken: loaded.credentials.access_token,
				refreshed: false,
				oauthHost: props.oauthHost,
				clientId: props.clientId,
				...(at.storage === "file" ? { credentialsPath: at.path } : {}),
			});
			const result = await handleExistingToken(
				loaded.credentials,
				props,
				at,
			);
			if (result) {
				props.apiKey = result.apiKey;
				props.apiClient = result.apiClient;
				setAuthContext({
					source: "stored-credentials",
					configDir: props.configDir,
					profile: selection.profile,
					storage: at.storage,
					accessToken: result.apiKey,
					refreshed: result.refreshed,
					oauthHost: props.oauthHost,
					clientId: props.clientId,
					...(at.storage === "file"
						? { credentialsPath: at.path }
						: {}),
				});
				return;
			}
		} catch (err) {
			if (err instanceof AuthRefreshError) {
				if (isLocalDev || isBootstrap || isMcp) {
					log.warning(
						"%s Continuing without credentials.",
						err.message,
					);
					return;
				}
				throw err;
			}
			throw err;
		}
	} else {
		log.debug(
			"No usable credentials at %s, starting authentication",
			credentialLabel(at),
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

	if (isMcp) {
		log.debug(
			"mcp: no usable credentials; minting requires auth or --oauth",
		);
		return;
	}

	// Use the resolved profile so `NEON_PROFILE` cannot overwrite `DEFAULT`.
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
		storage: at.storage,
		accessToken: apiKey,
		refreshed: true,
		oauthHost: props.oauthHost,
		clientId: props.clientId,
		...(at.storage === "file" ? { credentialsPath: at.path } : {}),
	});
};

/**
 * Accept an exact location because deriving it from a config directory used to
 * delete DEFAULT when a named profile failed.
 */
export const deleteCredentialsAt = (
	at: CredentialLocation,
	configDir: string,
): void => {
	try {
		const store = storeFor(configDir);
		const before = store.inspect(at);
		store.delete(at);
		if (before.credentials !== null || before.file === "ok") {
			log.info("Deleted credentials from %s", credentialLabel(at));
		} else {
			log.debug("No stored credential at %s", credentialLabel(at));
		}
	} catch (err) {
		const typedErr =
			err instanceof Error ? err : new Error("Unknown error");
		log.error("Failed to delete credentials: %s", typedErr.message);
		throw new Error("CREDENTIALS_DELETE_FAILED");
	}
};

const md5hash = (s: string) => createHash("md5").update(s).digest("hex");
