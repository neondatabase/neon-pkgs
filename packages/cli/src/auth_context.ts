import type { CredentialLocation } from "@neon-internals/cli-core/credentials";
import { isOwnedCredentialPath } from "./config.js";

/**
 * How the current invocation authenticated, recorded by `ensureAuth` so the top-level 401
 * handler can react to the credential that actually failed.
 *
 * - `api-key`: an explicit `--api-key` flag or `NEON_API_KEY`.
 * - `profile-api-key`: an API key read from the selected profile.
 * - `stored-credentials`: an OAuth token set from the selected profile.
 *
 * The context carries the resolved profile and its pointer, not just the config directory.
 * The 401 handler runs outside yargs and has no parsed arguments, so without them it could
 * neither name the profile in the error nor tell which credential to clear — it cleared
 * whatever `DEFAULT` pointed at, which for a `--profile`-selected command was the wrong
 * account's.
 */
export type AuthSource = "api-key" | "profile-api-key" | "stored-credentials";

export type AuthContext = {
	source: AuthSource;
	configDir: string;
	/** The selected profile, when one was resolved. */
	profile?: string;
	storage?: "file" | "keyring";
	/** The exact credentials file the invocation read, when it read a file. */
	credentialsPath?: string;
};

export const locationFromContext = (
	context: AuthContext,
): CredentialLocation | null => {
	if (context.profile === undefined) return null;
	if (context.storage === "keyring") {
		return { profile: context.profile, storage: "keyring" };
	}
	if (context.credentialsPath === undefined) return null;
	return {
		profile: context.profile,
		storage: "file",
		path: context.credentialsPath,
	};
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
): CredentialLocation | null => {
	if (context?.source !== "stored-credentials") return null;
	const at = locationFromContext(context);
	if (at === null) return null;
	if (at.storage === "keyring") return at;

	// Only a file the CLI created. A profile entry may point anywhere, and a credentials file
	// we merely adopted is not ours to delete — `neon profile remove` already refuses to touch
	// one, so a 401 must not quietly do what an explicit removal declines to.
	//
	// The legacy `neonctl` directory counts as ours: default resolution deliberately still
	// reads it in place, so an install predating the rename would otherwise have its own
	// credentials called "adopted" and never cleared.
	return isOwnedCredentialPath(context.configDir, at.path) ? at : null;
};

/**
 * What to tell the user when the API rejects their credential, naming the profile and file
 * when one is involved so they know which of several accounts failed and what to re-run.
 */
export const authFailureMessage = (context: AuthContext | null): string => {
	const profile = context?.profile ?? "the selected profile";
	const where =
		context?.storage === "keyring"
			? " (OS keyring)"
			: context?.credentialsPath !== undefined
				? ` (${context.credentialsPath})`
				: "";

	if (context?.source === "profile-api-key") {
		// Not `rotate-key`: a rejected key cannot authenticate to mint its own replacement.
		return `Authentication failed: the Neon API rejected profile "${profile}"'s API key${where}. Replace it with \`neon profile create ${profile} --mint --force\`, or store another with \`neon profile create ${profile} --api-key - --force\`.`;
	}

	// Reached only when the session was not ours to clear, i.e. an adopted credentials file.
	// Saying "check --api-key" there would be nonsense; the fix is to sign in again.
	if (context?.source === "stored-credentials") {
		return `Authentication failed: the Neon API rejected profile "${profile}"'s stored session${where}. That file was not created by neon, so it was left alone — sign in again with \`neon auth --profile ${profile}\`.`;
	}

	return "Authentication failed: the Neon API rejected the API key. Check --api-key or NEON_API_KEY.";
};
