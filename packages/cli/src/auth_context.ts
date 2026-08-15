import type { CredentialLocation } from "@neon-internals/cli-core/credentials";
import { isOwnedCredentialPath } from "./config.js";

/**
 * The 401 handler runs outside yargs, so it needs the exact authentication source
 * to avoid clearing DEFAULT after a named-profile failure.
 */
export type AuthSource = "api-key" | "profile-api-key" | "stored-credentials";

export type AuthContext = {
	source: AuthSource;
	configDir: string;
	/** The selected profile, when one was resolved. */
	profile?: string;
	storage?: "file" | "keyring";
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

export const credentialsToClearOn401 = (
	context: AuthContext | null,
): CredentialLocation | null => {
	if (context?.source !== "stored-credentials") return null;
	const at = locationFromContext(context);
	if (at === null) return null;
	if (at.storage === "keyring") return null;

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
		if (context.storage === "keyring") {
			return `Authentication failed: the Neon API rejected profile "${profile}"'s stored session (OS keyring). Sign in again with \`neon auth --profile ${profile}\`.`;
		}
		return `Authentication failed: the Neon API rejected profile "${profile}"'s stored session${where}. That file was not created by neon, so it was left alone — sign in again with \`neon auth --profile ${profile}\`.`;
	}

	return "Authentication failed: the Neon API rejected the API key. Check --api-key or NEON_API_KEY.";
};
