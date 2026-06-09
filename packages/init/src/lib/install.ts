import { log, spinner } from "@clack/prompts";
import { execa } from "execa";
import { getAddMcpAgentId } from "./agents.js";
import {
	type AuthOptions,
	createApiKeyFromNeonctl,
	ensureNeonctlAuth,
} from "./auth.js";
import {
	configureExtension,
	installExtension,
	usesExtension,
	waitForExtensionInstalled,
} from "./extension.js";
import type { Editor, InstallStatus } from "./types.js";

const NEON_MCP_SERVER_URL = "https://mcp.neon.tech/mcp";

/**
 * Installs Neon MCP Server for a single editor via the add-mcp CLI.
 * Uses API key authentication via the Authorization header.
 */
async function installMCPServerViaAddMcp(
	editor: Editor,
	apiKey: string,
): Promise<void> {
	const agentId = getAddMcpAgentId(editor);

	await execa(
		"npx",
		[
			"-y",
			"add-mcp",
			NEON_MCP_SERVER_URL,
			"--header",
			`Authorization: Bearer ${apiKey}`,
			"-g",
			"-n",
			"Neon",
			"-y",
			"-a",
			agentId,
		],
		{
			stdio: "pipe",
			timeout: 60000,
		},
	);
}

export interface InstallNeonOptions {
	json?: boolean;
}

/**
 * Installs Neon's Local Connect extension or MCP Server for specific editors.
 * Returns a map of editor → install status and whether auth succeeded.
 */
export async function installNeon(
	selectedEditors: Editor[],
	options?: InstallNeonOptions,
): Promise<{ results: Map<Editor, InstallStatus>; authSuccess: boolean }> {
	const quiet = options?.json === true;
	const authOptions: AuthOptions = { json: quiet };
	const results = new Map<Editor, InstallStatus>();

	const extensionEditors = selectedEditors.filter(usesExtension);
	const mcpEditors = selectedEditors.filter((e) => !usesExtension(e));

	if (extensionEditors.length === 0 && mcpEditors.length === 0) {
		return { results, authSuccess: false };
	}

	const authSpinner = quiet ? null : spinner();
	authSpinner?.start("Authenticating...");

	const authSuccess = await ensureNeonctlAuth(authOptions);

	if (!authSuccess) {
		authSpinner?.stop("Authentication failed");
		for (const editor of selectedEditors) {
			results.set(editor, "failed");
		}
		return { results, authSuccess: false };
	}

	authSpinner?.stop("Authentication successful ✓");

	const apiKey = await createApiKeyFromNeonctl(authOptions);

	if (!apiKey) {
		if (!quiet) {
			log.error("Could not create API key after authentication.");
			log.info(
				"You can manually create one at: https://console.neon.tech/app/settings/api-keys",
			);
		}
		for (const editor of selectedEditors) {
			results.set(editor, "failed");
		}
		return { results, authSuccess: true };
	}

	for (const editor of extensionEditors) {
		const installSuccess = await installExtension(editor);

		if (!installSuccess) {
			results.set(editor, "failed");
			continue;
		}

		const isReady = await waitForExtensionInstalled(editor);
		if (!isReady) {
			results.set(editor, "failed");
			continue;
		}

		const configSuccess = await configureExtension(editor, apiKey);

		if (configSuccess) {
			results.set(editor, "success");
		} else {
			results.set(editor, "failed");
		}
	}

	if (mcpEditors.length > 0) {
		const mcpSpinner = quiet ? null : spinner();
		mcpSpinner?.start("Installing and configuring Neon MCP Server...");

		let mcpSuccessCount = 0;
		for (const editor of mcpEditors) {
			try {
				await installMCPServerViaAddMcp(editor, apiKey);
				results.set(editor, "success");
				mcpSuccessCount++;
			} catch (err) {
				results.set(editor, "failed");
				if (
					!quiet &&
					err &&
					typeof err === "object" &&
					"stderr" in err &&
					err.stderr
				) {
					log.error(
						String(err.stderr).trim() ||
							"failed to install MCP server via add-mcp",
					);
				}
			}
		}

		mcpSpinner?.stop(
			mcpSuccessCount > 0
				? "Neon MCP Server configuration complete ✓"
				: "Failed to configure Neon MCP Server",
		);
	}

	return { results, authSuccess: true };
}
