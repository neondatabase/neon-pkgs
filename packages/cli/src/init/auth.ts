import { log } from "@clack/prompts";
import {
	inspectCredentials,
	interpretCredentials,
} from "@neon-internals/cli-core/credentials";
import { resolveConfigFile } from "@neon-internals/cli-core/paths";
import { DEFAULT_PROFILE } from "@neon-internals/cli-core/profiles";
import { execa } from "execa";

export type AuthOptions = {
	json?: boolean;
};

/**
 * Ensures neonctl is authenticated by running a command that triggers auth if needed
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
		await execa("npx", ["-y", "neon", "me"], {
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
 * Checks whether neonctl has stored OAuth credentials.
 */
export async function isAuthenticated(): Promise<boolean> {
	const token = await getNeonctlAccessToken();
	return token !== null;
}

/**
 * The credential the Neon CLI has stored, or `null` when there is none.
 *
 * Shares the reader with `neon` and `@neon/env` rather than keeping a copy — the inline path
 * resolution this replaced was the third implementation of "where is the config directory", and
 * it also looked only for `access_token`, so an account signed in with an API key read as not
 * authenticated and got sent to a browser. See `internals/cli-core/README.md`.
 *
 * `null` means *absent*, and only absent. A file that exists and cannot be read throws: this
 * value decides whether to start a browser sign-in, and a sign-in overwrites the file it could
 * not read — as a different account, if a different one is chosen. Catching every error here
 * made a damaged credential indistinguishable from a fresh machine.
 */
async function getNeonctlAccessToken(): Promise<string | null> {
	const { path } = resolveConfigFile("credentials.json");
	const read = inspectCredentials(path);
	if (read.kind === "absent") return null;
	if (read.kind === "unusable") {
		throw new Error(
			`${read.reason}. Replace it deliberately with \`neon profile create ${DEFAULT_PROFILE} --force\`, or delete the file.`,
		);
	}
	// `neon init` has no profile selection — it reads the default credential and refuses
	// when one is named, so `DEFAULT` is the only profile this can ever be about.
	const credential = interpretCredentials(read.credentials, {
		path,
		profile: DEFAULT_PROFILE,
	});
	if (credential.kind === "api_key") return credential.apiKey;
	const token = read.credentials.access_token;
	return typeof token === "string" && token.trim() !== "" ? token : null;
}
