import { log, spinner } from "@clack/prompts";
import { execa } from "execa";
import { getAddMcpAgentId } from "./agents.js";
import { createApiKeyFromNeonctl, ensureNeonctlAuth } from "./auth.js";
import {
	configureExtension,
	installExtension,
	usesExtension,
	waitForExtensionInstalled,
} from "./extension.js";
import type { Editor, InstallStatus } from "./types.js";

const NEON_MCP_SERVER_URL = "https://mcp.neon.tech/mcp";

/**
 * Installs Neon MCP Server for the given editors via the add-mcp CLI.
 * Uses API key authentication via the Authorization header.
 */
async function installMCPServerViaAddMcp(
	editors: Editor[],
	apiKey: string,
): Promise<void> {
	const agentFlags = editors.flatMap((e) => ["-a", getAddMcpAgentId(e)]);

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
			...agentFlags,
		],
		{
			stdio: "pipe",
			timeout: 60000,
		},
	);
}

/**
 * Installs Neon's Local Connect extension or MCP Server for specific editors
 */
export async function installNeon(
	selectedEditors: Editor[],
): Promise<Map<Editor, InstallStatus>> {
	const results = new Map<Editor, InstallStatus>();

	const extensionEditors = selectedEditors.filter(usesExtension);
	const mcpEditors = selectedEditors.filter((e) => !usesExtension(e));

	if (extensionEditors.length === 0 && mcpEditors.length === 0) {
		return results;
	}

	const authSpinner = spinner();
	authSpinner.start("Authenticating...");

	const authSuccess = await ensureNeonctlAuth();

	if (!authSuccess) {
		authSpinner.stop("Authentication failed");
		for (const editor of selectedEditors) {
			results.set(editor, "failed");
		}
		return results;
	}

	authSpinner.stop("Authentication successful ✓");

	// Create API key using the OAuth token
	const apiKey = await createApiKeyFromNeonctl();

	if (!apiKey) {
		log.error("Could not create API key after authentication.");
		log.info(
			"You can manually create one at: https://console.neon.tech/app/settings/api-keys",
		);
		for (const editor of selectedEditors) {
			results.set(editor, "failed");
		}
		return results;
	}

	for (const editor of extensionEditors) {
		const installSuccess = await installExtension(editor);

		if (!installSuccess) {
			results.set(editor, "failed");
			continue;
		}

		const isReady = await waitForExtensionInstalled(editor);
		if (!isReady) {
			// Extension install command succeeded but extension didn't appear in list
			results.set(editor, "failed");
			continue;
		}

		// Configure the extension with the API key
		const configSuccess = await configureExtension(editor, apiKey);

		if (configSuccess) {
			results.set(editor, "success");
		} else {
			// Extension installed but auth failed but user can manually configure later
			results.set(editor, "success");
		}
	}

	if (mcpEditors.length > 0) {
		const mcpSpinner = spinner();
		mcpSpinner.start("Installing and configuring Neon MCP Server...");

		try {
			await installMCPServerViaAddMcp(mcpEditors, apiKey);
			mcpSpinner.stop("Neon MCP Server configured ✓");
			for (const editor of mcpEditors) {
				results.set(editor, "success");
			}
		} catch (error) {
			mcpSpinner.stop("Failed to configure Neon MCP Server");
			for (const editor of mcpEditors) {
				results.set(editor, "failed");
			}
		}
	}

	return results;
}
