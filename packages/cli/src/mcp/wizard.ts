import prompts from "prompts";

import { log } from "../log.js";
import { canPickAgentsInteractively } from "../utils/agent_picker.js";
import { type AgentType, getAgentDisplayName } from "./agents.js";
import type { McpInstallScope } from "./install.js";
import type { SkippedMcpTarget } from "./targets.js";

export type McpAuthKind = "api-key" | "oauth";

const restoreCursorOnAbort = (state: { aborted: boolean }) => {
	if (state.aborted) {
		// prompts leaves the cursor hidden when selection is aborted.
		process.stdout.write("\x1B[?25h");
		process.stdout.write("\n");
		process.exit(1);
	}
};

export const pickMcpScope = async (): Promise<McpInstallScope> => {
	if (!canPickAgentsInteractively()) {
		throw new Error(
			"No interactive terminal. Pass --project for project config, or -y for global.",
		);
	}
	const { scope } = await prompts({
		onState: restoreCursorOnAbort,
		type: "select",
		name: "scope",
		message: "Where should the Neon MCP server be installed?",
		initial: 0,
		choices: [
			{
				title: "Global",
				value: "global",
				description: "User-level agent config",
			},
			{
				title: "Project",
				value: "project",
				description: "This directory",
			},
		],
	});
	if (scope !== "global" && scope !== "project") {
		throw new Error("Aborted.");
	}
	return scope;
};

export const pickMcpAuth = async (): Promise<McpAuthKind> => {
	if (!canPickAgentsInteractively()) {
		throw new Error(
			"No interactive terminal. Pass --oauth for OAuth, or -y to mint an API key.",
		);
	}
	const { auth } = await prompts({
		onState: restoreCursorOnAbort,
		type: "select",
		name: "auth",
		message: "How should agents authenticate to Neon?",
		initial: 0,
		choices: [
			{
				title: "API key",
				value: "api-key",
				description: "Mint a key and write it into agent config",
			},
			{
				title: "OAuth",
				value: "oauth",
				description: "The agent signs in on first use",
			},
		],
	});
	if (auth !== "api-key" && auth !== "oauth") {
		throw new Error("Aborted.");
	}
	return auth;
};

export const pickMcpProjectPin = async (
	linkedProjectId: string,
): Promise<boolean> => {
	if (!canPickAgentsInteractively()) {
		return false;
	}
	const { pin } = await prompts({
		onState: restoreCursorOnAbort,
		type: "confirm",
		name: "pin",
		message: `Pin MCP tools to the linked project ${linkedProjectId}?`,
		initial: true,
	});
	return pin === true;
};

export const mcpInstallSummary = (options: {
	scope: McpInstallScope;
	install: readonly AgentType[];
	skipped: readonly SkippedMcpTarget[];
	auth: McpAuthKind;
	reuse: boolean;
	url: string;
}): string => {
	const agents = options.install.map(getAgentDisplayName).join(", ");
	const auth =
		options.auth === "oauth"
			? "OAuth (agent signs in on first use)"
			: options.reuse
				? "reuse the API key already in agent config"
				: "mint an account-wide API key that reaches every organization";
	const lines = [
		`Scope: ${options.scope}`,
		`Agents: ${agents}`,
		`Auth: ${auth}`,
		`URL: ${options.url}`,
	];
	if (options.skipped.length > 0) {
		lines.push(
			`Skipped: ${options.skipped
				.map(
					(row) => `${getAgentDisplayName(row.agent)} (${row.error})`,
				)
				.join("; ")}`,
		);
	}
	return lines.join("\n");
};

export const confirmMcpInstall = async (options: {
	scope: McpInstallScope;
	install: readonly AgentType[];
	skipped: readonly SkippedMcpTarget[];
	auth: McpAuthKind;
	reuse: boolean;
	url: string;
}): Promise<boolean> => {
	if (!canPickAgentsInteractively()) {
		return true;
	}
	log.info(mcpInstallSummary(options));
	const { ok } = await prompts({
		onState: restoreCursorOnAbort,
		type: "confirm",
		name: "ok",
		message: "Write the Neon MCP server into these agents?",
		initial: true,
	});
	return ok === true;
};
