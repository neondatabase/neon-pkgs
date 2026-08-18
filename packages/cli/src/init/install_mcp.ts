import { type AgentType, agents, upsertServer } from "add-mcp";

export const NEON_MCP_URL = "https://mcp.neon.tech/mcp";
export const NEON_MCP_NAME = "Neon";

export type McpInstallScope = "global" | "project";

export type NeonMcpInstallResult =
	| { ok: true; path: string }
	| { ok: false; unsupported: true; error: string }
	| { ok: false; unsupported: false; error: string };

export function installNeonMcpServer(options: {
	agent: AgentType;
	scope: McpInstallScope;
	cwd?: string;
}): NeonMcpInstallResult {
	const agent = agents[options.agent];

	// upsertServer will still write an HTTP entry Claude Desktop cannot load.
	if (!agent.supportedTransports.includes("http")) {
		return {
			ok: false,
			unsupported: true,
			error:
				agent.unsupportedTransportMessage ??
				`${agent.displayName} does not support remote HTTP MCP servers.`,
		};
	}

	// add-mcp errors on local+no localConfigPath; do not fall back to global.
	if (options.scope === "project" && !agent.localConfigPath) {
		return {
			ok: false,
			unsupported: true,
			error: `${agent.displayName} does not support project-level MCP config.`,
		};
	}

	const result = upsertServer(
		options.agent,
		NEON_MCP_NAME,
		{ type: "http", url: NEON_MCP_URL },
		{ local: options.scope === "project", cwd: options.cwd },
	);

	if (result.success) {
		return { ok: true, path: result.path };
	}

	return {
		ok: false,
		unsupported: false,
		error: result.error ?? "Failed to write Neon MCP server config",
	};
}
