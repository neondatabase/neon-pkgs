import { detectProjectAgents } from "add-mcp";

import {
	type AgentType,
	detectInstalledAgents,
	listMcpAgentIds,
	resolveAddMcpAgentId,
	uniqueAgentIds,
} from "./agents.js";
import { type McpInstallScope, mcpUnsupportedReason } from "./install.js";

export type SkippedMcpTarget = {
	agent: AgentType;
	error: string;
};

export type ResolvedMcpTargets = {
	install: AgentType[];
	skipped: SkippedMcpTarget[];
};

export function mcpInstallableAgents(scope: McpInstallScope): AgentType[] {
	return listMcpAgentIds().filter(
		(id) => mcpUnsupportedReason(id, scope) === undefined,
	);
}

export async function detectMcpAgents(options: {
	scope: McpInstallScope;
	cwd: string;
}): Promise<AgentType[]> {
	const detected =
		options.scope === "project"
			? detectProjectAgents(options.cwd)
			: await detectInstalledAgents();
	return uniqueAgentIds(detected).filter(
		(id) => mcpUnsupportedReason(id, options.scope) === undefined,
	);
}

export function resolveInstallTargets(options: {
	agents: string[];
	scope: McpInstallScope;
}): ResolvedMcpTargets {
	const requested = uniqueAgentIds(options.agents.map(resolveAddMcpAgentId));
	const install: AgentType[] = [];
	const skipped: SkippedMcpTarget[] = [];
	for (const agent of requested) {
		const error = mcpUnsupportedReason(agent, options.scope);
		if (error) {
			skipped.push({ agent, error });
		} else {
			install.push(agent);
		}
	}

	if (install.length === 0) {
		const details = skipped.map((row) => row.error).join(" ");
		throw new Error(
			details ||
				`None of the selected agents can install the Neon MCP server. Supported agents: ${mcpInstallableAgents(options.scope).join(", ")}`,
		);
	}

	return { install, skipped };
}
