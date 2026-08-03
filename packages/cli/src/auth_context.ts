import { isInsideConfigDir } from "./config.js";

/**
 * How the current invocation authenticated, recorded by `ensureAuth` so the top-level 401
 * handler can react to the credential that actually failed.
 *
 * - `api-key`: an explicit `--api-key` flag or `NEON_API_KEY`.
 * - `profile-api-key`: an API key read from the selected profile's credentials file.
 * - `stored-credentials`: an OAuth token set from the selected profile's credentials file.
 *
 * The context carries the resolved profile name and the exact file, not just the config
 * directory. The 401 handler runs outside yargs and has no parsed arguments, so without them
 * it could neither name the profile in the error nor tell which of several credentials files
 * to clear — it cleared whatever `DEFAULT` pointed at, which for a `--profile`-selected
 * command was the wrong account's.
 */
export type AuthSource = "api-key" | "profile-api-key" | "stored-credentials";

export type AuthContext = {
	source: AuthSource;
	configDir: string;
	/** The selected profile, when one was resolved. */
	profile?: string;
	/** The exact credentials file the invocation read, when it read one. */
	credentialsPath?: string;
};

let current: AuthContext | null = null;

export const setAuthContext = (context: AuthContext): void => {
	current = context;
};

export const getAuthContext = (): AuthContext | null => current;

/** Reset between tests, so one case cannot observe another's authentication. */
export const clearAuthContext = (): void => {
	current = null;
};

/**
 * The credentials file a 401 should delete, or `null` to leave everything on disk.
 *
 * Only an expired OAuth token set is worth clearing: deleting it makes the next command log
 * in again, which is the recovery. Neither key-shaped source is.
 *
 * A key passed on the command line was never ours to store, so a 401 on it says nothing about
 * any stored credential — clearing one would sign the user out of an account the failed
 * request never used.
 *
 * A key read from a profile must survive for a sharper reason: unlike an OAuth token there is
 * nothing to refresh and no automatic way back, so deleting it would destroy the only copy of
 * a credential the user has to paste or mint again. It is also the expected state during
 * rotation, where the whole point is that the old key is dead and the file must still be there
 * to be replaced.
 */
export const credentialsToClearOn401 = (
	context: AuthContext | null,
): string | null => {
	if (context?.source !== "stored-credentials") return null;
	const path = context.credentialsPath;
	if (path === undefined) return null;

	// Only a file the CLI created. A profile entry may point anywhere, and a credentials file
	// we merely adopted is not ours to delete — `neon profile remove` already refuses to touch
	// one, so a 401 must not quietly do what an explicit removal declines to.
	return isInsideConfigDir(context.configDir, path) ? path : null;
};

/**
 * What to tell the user when the API rejects their credential, naming the profile and file
 * when one is involved so they know which of several accounts failed and what to re-run.
 */
export const authFailureMessage = (context: AuthContext | null): string => {
	const profile = context?.profile ?? "the selected profile";
	const where =
		context?.credentialsPath !== undefined
			? ` (${context.credentialsPath})`
			: "";

	if (context?.source === "profile-api-key") {
		return `Authentication failed: the Neon API rejected profile "${profile}"'s API key${where}. Mint a replacement with \`neon profile rotate-key ${profile}\`, or store a new one with \`neon profile set-key ${profile}\`.`;
	}

	// Reached only when the session was not ours to clear, i.e. an adopted credentials file.
	// Saying "check --api-key" there would be nonsense; the fix is to sign in again.
	if (context?.source === "stored-credentials") {
		return `Authentication failed: the Neon API rejected profile "${profile}"'s stored session${where}. That file was not created by neon, so it was left alone — sign in again with \`neon auth --profile ${profile}\`.`;
	}

	return "Authentication failed: the Neon API rejected the API key. Check --api-key or NEON_API_KEY.";
};
