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
export const authFailureMessage = (
	context: AuthContext | null,
	agent = false,
): string => {
	const profile = context?.profile ?? "the selected profile";
	const where =
		context?.storage === "keyring"
			? " (OS keyring)"
			: context?.credentialsPath !== undefined
				? ` (${context.credentialsPath})`
				: "";

	if (context?.source === "profile-api-key") {
		// `--mint` needs a browser sign-in, which an agent may have no one to finish.
		if (agent) {
			return `Authentication failed: the Neon API rejected profile "${profile}"'s API key${where}. Replace it with an API key the user already has: \`neon profile create ${profile} --api-key -\`. ${NO_NEW_API_KEY}`;
		}
		// Not `rotate-key`: a rejected key cannot authenticate to mint its own replacement.
		return `Authentication failed: the Neon API rejected profile "${profile}"'s API key${where}. Replace it with \`neon profile create ${profile} --mint\`, or store another with \`neon profile create ${profile} --api-key -\`.`;
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

	const rejected =
		context?.apiKeyFrom === "env"
			? "Authentication failed: the Neon API rejected NEON_API_KEY. It takes precedence over a saved sign-in, so unset it to use that session, or set a valid key."
			: context?.apiKeyFrom === "flag"
				? "Authentication failed: the Neon API rejected the key passed with --api-key. Pass a valid key, or drop --api-key to use a saved sign-in."
				: "Authentication failed: the Neon API rejected the API key. Check --api-key or NEON_API_KEY.";
	return agent ? `${rejected} ${NO_NEW_API_KEY}` : rejected;
};

export const NO_NEW_API_KEY = "Do not ask the user to create an API key.";

/**
 * What an agent does when the CLI has no usable credential. Claimable Neon makes a separate,
 * temporary project, so it is offered only when nothing was ever stored (an expired session
 * means the user has an account) and the directory isn't linked to a project.
 */
export const signInGuidance = (input: {
	cli: string;
	profile: string;
	/** True when --profile or NEON_PROFILE chose the profile; NEON_API_KEY can't apply then. */
	explicitProfile: boolean;
	offerClaimable: boolean;
	/** False where interactive sign-in is refused (CI), so only the alternatives are named. */
	browser: boolean;
}): string => {
	const { cli, profile } = input;
	const existingKey = input.explicitProfile
		? `store an API key the user already has with \`${cli} profile create ${profile} --api-key -\``
		: "set an API key the user already has as NEON_API_KEY";
	const options = input.offerClaimable
		? `${existingKey}, or create a separate temporary project without an account with \`${cli} claim create\` (it expires in 72 hours unless claimed)`
		: `tell the user they need to sign in or to ${existingKey}, and stop`;
	return [
		...(input.browser
			? [
					`If someone can complete a browser sign-in that reaches this machine's 127.0.0.1 callback, run \`${cli} login --profile ${profile}\`.`,
					`If no one can, ${options}.`,
				]
			: [`${options.charAt(0).toUpperCase()}${options.slice(1)}.`]),
		NO_NEW_API_KEY,
	].join(" ");
};
