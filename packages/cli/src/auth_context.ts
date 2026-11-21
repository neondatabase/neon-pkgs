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
	/** Where an `api-key` source came from: the `--api-key` flag or `NEON_API_KEY`. */
	apiKeyFrom?: "flag" | "env";
	configDir: string;
	/** The selected profile, when one was resolved. */
	profile?: string;
	storage?: "file" | "keyring";
	credentialsPath?: string;
	accessToken?: string;
	refreshed?: boolean;
	oauthHost?: string;
	clientId?: string;
	/** The linked project a `claimable` source authenticates as. */
	claimableProject?: { id: string; expiresAt: string };
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
		return `Authentication failed: the Neon API rejected profile "${profile}"'s API key${where}. Save a valid key with \`${saveKeyCommand("neon", profile)}\`, or sign in with a browser on this machine to mint one with \`neon profile create ${profile} --mint\`.`;
	}

	if (context?.source === "claimable") {
		return `Authentication failed: Claimable Neon rejected the linked project's short-lived access token${where}. Retry the command to exchange the saved identity assertion again; if it still fails, run \`neon claim status\`.`;
	}

	if (context?.source === "stored-credentials") {
		if (context.storage === "keyring") {
			return `Authentication failed: the Neon API rejected profile "${profile}"'s stored session (OS keyring). Sign in again with \`neon login --profile ${profile}\`.`;
		}
		return `Authentication failed: the Neon API rejected profile "${profile}"'s stored session${where}. Sign in again with \`neon login --profile ${profile}\`.`;
	}

	if (context?.apiKeyFrom === "env") {
		return "Authentication failed: the Neon API rejected NEON_API_KEY. It takes precedence over a saved sign-in, so unset it to use that session, or set a valid key.";
	}
	if (context?.apiKeyFrom === "flag") {
		return "Authentication failed: the Neon API rejected the key passed with --api-key. Pass a valid key, or drop --api-key to use a saved sign-in.";
	}
	return "Authentication failed: the Neon API rejected the API key. Check --api-key or NEON_API_KEY.";
};

/** `--api-key -` refuses a terminal on stdin, so the key is piped in. */
export const saveKeyCommand = (cli: string, profile: string): string =>
	`echo "$KEY" | ${cli} profile create ${profile} --api-key -`;

/**
 * The ways to authenticate when the CLI has no usable credential, one per line. Claimable
 * Neon makes a separate, temporary project, so it is offered only when nothing was ever
 * stored (an expired session means the user has an account) and the directory isn't linked
 * to a project.
 */
export const signInGuidance = (input: {
	cli: string;
	profile: string;
	/** True when --profile or NEON_PROFILE chose the profile, so commands must name it. */
	explicitProfile: boolean;
	offerClaimable: boolean;
	/** CI refuses browser sign-in and keeps keys in its secrets, so NEON_API_KEY is the key path. */
	ci: boolean;
}): string => {
	const { cli, profile } = input;
	return [
		...(input.ci
			? [
					// A selected profile overrides NEON_API_KEY.
					input.explicitProfile
						? `Save an API key to this profile: \`${saveKeyCommand(cli, profile)}\``
						: "Set NEON_API_KEY to an API key.",
				]
			: [
					`Sign in with a browser on this machine: \`${cli} login${input.explicitProfile ? ` --profile ${profile}` : ""}\``,
					`Or save an API key you already have: \`${saveKeyCommand(cli, profile)}\``,
				]),
		...(input.offerClaimable
			? [
					`Or create a temporary project without an account: \`${cli} claim create\` (it expires in 72 hours unless claimed)`,
				]
			: []),
	].join("\n");
};
