import { log } from "@clack/prompts";
import { interpretCredentials } from "@neon-internals/cli-core/credentials";
import { configDir } from "@neon-internals/cli-core/paths";
import { locationForName } from "@neon-internals/cli-core/profiles";
import { execa } from "execa";
import { storeFor } from "../credential_io.js";
import { npxNeonArgs, selectedProfileName } from "./profile_cli.js";

export type AuthOptions = {
	json?: boolean;
};

/**
 * Ensures the Neon CLI is authenticated by running a command that triggers auth if needed
 * This will automatically start the OAuth flow if the user isn't already authenticated
 */
export async function ensureNeonctlAuth(
	options?: AuthOptions,
): Promise<boolean> {
	const quiet = options?.json === true;

	// If already authenticated (e.g. ran in a terminal before), we can proceed
	const existingToken = await getNeonctlAccessToken();
	if (existingToken) return true;

	try {
		// Run `neon me`, which triggers the OAuth flow when not signed in.
		await execa("npx", npxNeonArgs(["me"]), {
			// Shows OAuth URL and prompts to the user
			stdio: "inherit",
			// Unset CI so the CLI doesn't refuse to open the browser (e.g. when run from agent chat)
			env: { ...process.env, CI: undefined },
		});
		return true;
	} catch (error) {
		const msg = error instanceof Error ? error.message : "Unknown error";
		if (!quiet) {
			if (msg.includes("interactive auth") || msg.includes("CI")) {
				log.error(
					"Auth requires an interactive terminal. Run neon init in your system terminal (outside the chat) to sign in.",
				);
			} else {
				log.error(`Authentication failed: ${msg}`);
			}
		}
		return false;
	}
}

/**
 * Checks whether the Neon CLI has stored OAuth credentials.
 */
export async function isAuthenticated(): Promise<boolean> {
	const token = await getNeonctlAccessToken();
	return token !== null;
}

/**
 * Sharing the reader keeps init aligned with CLI path and API-key handling.
 * Unreadable credentials throw so browser sign-in cannot overwrite them.
 */
async function getNeonctlAccessToken(): Promise<string | null> {
	const at = locationForName(configDir(), selectedProfileName());
	const loaded = storeFor(configDir()).read(at);
	if (loaded === null) return null;
	const credential = interpretCredentials(
		loaded.credentials,
		at,
		loaded.backend,
	);
	if (credential.kind === "api_key") return credential.apiKey;
	const token = loaded.credentials.access_token;
	return typeof token === "string" && token.trim() !== "" ? token : null;
}
