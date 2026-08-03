import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { log } from "@clack/prompts";
import { execa } from "execa";

export interface AuthOptions {
	json?: boolean;
}

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
		// Use execa to authenticate with neonctl
		await execa("npx", ["-y", "neonctl", "me"], {
			// Shows OAuth URL and prompts to the user
			stdio: "inherit",
			// Unset CI so neonctl doesn't refuse to open the browser (e.g. when run from agent chat)
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
 * Gets the OAuth access token from the Neon CLI's stored credentials.
 *
 * Kept inline rather than importing `@neon/config/paths`: this package has no workspace
 * dependencies, and taking one on `@neon/config` would pull `@neon/sdk`, `zod` and `jiti`
 * into the install footprint of a package whose only need here is a file path. The
 * resolution below must stay identical to `packages/config/src/paths.ts`, which is the
 * canonical implementation — and it collapses entirely once this package folds into
 * `packages/cli`.
 */
async function getNeonctlAccessToken(): Promise<string | null> {
	try {
		for (const path of credentialsCandidates()) {
			if (!existsSync(path)) continue;
			const credentials = JSON.parse(readFileSync(path, "utf-8"));
			if (credentials.access_token) return credentials.access_token;
		}
		return null;
	} catch {
		return null;
	}
}

/**
 * Where the Neon CLI may keep `credentials.json`, most specific first: an explicitly
 * configured directory, else `$XDG_CONFIG_HOME`/`~/.config` under the current `neon`
 * directory and then the legacy `neonctl` one. An explicit directory is exact — it never
 * falls back to the legacy name.
 */
function credentialsCandidates(): string[] {
	const env = process.env;
	const explicit =
		trimmed(env.NEON_CONFIG_DIR) ?? trimmed(env.NEONCTL_CONFIG_DIR);
	if (explicit) return [resolve(explicit, "credentials.json")];

	const home = trimmed(env.HOME) ?? trimmed(env.USERPROFILE);
	const base =
		trimmed(env.XDG_CONFIG_HOME) ??
		(home ? resolve(home, ".config") : null);
	if (!base) return [];
	return [
		resolve(base, "neon", "credentials.json"),
		resolve(base, "neonctl", "credentials.json"),
	];
}

function trimmed(value: string | undefined): string | null {
	const v = value?.trim();
	return v ? v : null;
}

/**
 * Creates an API key using the Neon API with the OAuth token from neonctl
 */
export async function createApiKeyFromNeonctl(
	options?: AuthOptions,
): Promise<string | null> {
	const quiet = options?.json === true;

	try {
		const accessToken = await getNeonctlAccessToken();
		if (!accessToken) {
			if (!quiet)
				log.error("Could not find OAuth token from the Neon CLI");
			return null;
		}

		// Generate a unique key name with timestamp
		const timestamp = new Date()
			.toISOString()
			.replace(/[:.]/g, "-")
			.slice(0, -5); // e.g., 2024-10-08T15-30-45
		const keyName = `neonctl-init-${timestamp}`;

		// Call Neon API to create an API key
		const apiBase = process.env.NEON_API_HOST
			? `${new URL(process.env.NEON_API_HOST).origin}/api/v2`
			: "https://console.neon.tech/api/v2";
		const response = await fetch(`${apiBase}/api_keys`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${accessToken}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				key_name: keyName,
			}),
			signal: AbortSignal.timeout(30000),
		});

		if (!response.ok) {
			const errorText = await response.text();
			if (!quiet)
				log.error(
					`Failed to create API key: ${response.status} ${errorText}`,
				);
			return null;
		}

		const data = await response.json();
		return data.key || null;
	} catch (error) {
		if (!quiet)
			log.error(
				`Failed to create API key: ${error instanceof Error ? error.message : "Unknown error"}`,
			);
		return null;
	}
}
