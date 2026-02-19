import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { log } from "@clack/prompts";
import { execa } from "execa";

/**
 * Ensures neonctl is authenticated by running a command that triggers auth if needed
 * This will automatically start the OAuth flow if the user isn't already authenticated
 */
export async function ensureNeonctlAuth(): Promise<boolean> {
	// If already authenticated (e.g. ran in a terminal before), we can proceed
	const existingToken = await getNeonctlAccessToken();
	if (existingToken) return true;

	try {
		// Use execa to authenticate with neonctl
		await execa("npx", ["-y", "neonctl", "me", "--no-analytics"], {
			// Shows OAuth URL and prompts to the user
			stdio: "inherit",
			// Unset CI so neonctl doesn't refuse to open the browser (e.g. when run from agent chat)
			env: { ...process.env, CI: undefined },
		});
		return true;
	} catch (error) {
		const msg = error instanceof Error ? error.message : "Unknown error";
		if (msg.includes("interactive auth") || msg.includes("CI")) {
			log.error(
				"Auth requires an interactive terminal. Run neon-init in your system terminal (outside the chat) to sign in.",
			);
		} else {
			log.error(`Authentication failed: ${msg}`);
		}
		return false;
	}
}

/**
 * Gets the OAuth access token from neonctl's stored credentials
 */
async function getNeonctlAccessToken(): Promise<string | null> {
	try {
		const homeDir = process.env.HOME || process.env.USERPROFILE;
		if (!homeDir) return null;

		const credentialsPath = resolve(
			homeDir,
			".config",
			"neonctl",
			"credentials.json",
		);
		if (!existsSync(credentialsPath)) return null;

		const credentials = JSON.parse(readFileSync(credentialsPath, "utf-8"));
		return credentials.access_token || null;
	} catch {
		return null;
	}
}

/**
 * Creates an API key using the Neon API with the OAuth token from neonctl
 */
export async function createApiKeyFromNeonctl(): Promise<string | null> {
	try {
		const accessToken = await getNeonctlAccessToken();
		if (!accessToken) {
			log.error("Could not find OAuth token from neonctl");
			return null;
		}

		// Generate a unique key name with timestamp
		const timestamp = new Date()
			.toISOString()
			.replace(/[:.]/g, "-")
			.slice(0, -5); // e.g., 2024-10-08T15-30-45
		const keyName = `neonctl-init-${timestamp}`;

		// Call Neon API to create an API key
		const response = await fetch(
			"https://console.neon.tech/api/v2/api_keys",
			{
				method: "POST",
				headers: {
					Authorization: `Bearer ${accessToken}`,
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					key_name: keyName,
				}),
			},
		);

		if (!response.ok) {
			const errorText = await response.text();
			log.error(
				`Failed to create API key: ${response.status} ${errorText}`,
			);
			return null;
		}

		const data = await response.json();
		return data.key || null;
	} catch (error) {
		log.error(
			`Failed to create API key: ${error instanceof Error ? error.message : "Unknown error"}`,
		);
		return null;
	}
}
