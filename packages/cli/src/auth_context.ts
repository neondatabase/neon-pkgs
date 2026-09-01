import type { CredentialLocation } from "@neon-internals/cli-core/credentials";

/**
 * The 401 handler runs outside yargs and cannot reconstruct the authentication
 * source or selected profile.
 */
export type AuthSource =
	| "api-key"
	| "profile-api-key"
	| "stored-credentials"
	| "claimable";

export type AuthContext = {
	source: AuthSource;
	configDir: string;
	/** The selected profile, when one was resolved. */
	profile?: string;
	storage?: "file" | "keyring";
	credentialsPath?: string;
	accessToken?: string;
	refreshed?: boolean;
	oauthHost?: string;
	clientId?: string;
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
		return `Authentication failed: the Neon API rejected profile "${profile}"'s API key${where}. Replace it with \`neon profile create ${profile} --mint\`, or store another with \`neon profile create ${profile} --api-key -\`.`;
	}

	if (context?.source === "claimable") {
		return `Authentication failed: Claimable Neon rejected the linked project's short-lived access token${where}. Retry the command to exchange the saved identity assertion again; if it still fails, run \`neon claim status\`.`;
	}

	if (context?.source === "stored-credentials") {
		if (context.storage === "keyring") {
			return `Authentication failed: the Neon API rejected profile "${profile}"'s stored session (OS keyring). Sign in again with \`neon auth --profile ${profile}\`.`;
		}
		return `Authentication failed: the Neon API rejected profile "${profile}"'s stored session${where}. Sign in again with \`neon auth --profile ${profile}\`.`;
	}

	return "Authentication failed: the Neon API rejected the API key. Check --api-key or NEON_API_KEY.";
};
