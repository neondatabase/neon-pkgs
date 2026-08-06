import { resolveAddMcpAgentId } from "../agents.js";
import { isAuthenticated } from "../auth.js";
import type { Editor, PhaseResponse } from "../types.js";

export type McpPhaseOptions = {
	agent?: string;
	editor?: Editor;
	status?: boolean;
	install?: boolean;
	scope?: "global" | "project";
	mcpConfigured?: boolean | null;
};

export async function handleMcpPhase(
	options: McpPhaseOptions,
): Promise<PhaseResponse> {
	const agentArgs = options.agent
		? ["--agent", options.agent, "--json"]
		: ["--json"];

	// --status: just report what we know
	if (options.status) {
		return {
			phase: "tooling",
			status: "status",
			nextAction: {
				type: "agent_check",
				checks: [
					{
						id: "mcp_server",
						description:
							"Check if the Neon MCP server is already configured in your MCP server list",
						lookFor: [
							"An MCP server entry named 'Neon' or with URL containing 'mcp.neon.tech'",
						],
					},
				],
				reportBack: {
					type: "run_neon_init",
					args: [
						"mcp",
						"--json",
						...(options.agent ? ["--agent", options.agent] : []),
						"--mcp-configured",
						"<true|false>",
					],
				},
			},
		};
	}

	// --install: proceed with installation
	if (options.install) {
		const authed = await isAuthenticated();
		if (!authed) {
			return {
				phase: "tooling",
				status: "auth_required",
				nextAction: {
					type: "run_neon_init",
					args: ["auth", "--json"],
				},
			};
		}

		// Build the add-mcp command
		const scope = options.scope ?? "global";
		const mcpAgentId = resolveAddMcpAgentId(options.agent ?? "claude-code");
		const isCursor =
			mcpAgentId === "cursor" ||
			options.agent?.toLowerCase() === "cursor";
		const isClaudeCode =
			mcpAgentId === "claude-code" ||
			options.agent?.toLowerCase() === "claude-code";
		const installCmd = [
			"npx -y add-mcp https://mcp.neon.tech/mcp",
			scope === "global" ? "-g" : "",
			"-n Neon",
			"-y",
			`-a ${mcpAgentId}`,
		]
			.filter(Boolean)
			.join(" ");

		let enableNote = "";
		if (isCursor && scope === "project") {
			enableNote =
				' Note: Cursor disables project-level MCP servers by default — after installation, open Cursor Settings > MCP and toggle the "Neon" server on.';
		} else if (isClaudeCode) {
			enableNote =
				' Note: Claude Code requires approval for newly added MCP servers. When prompted, approve the "Neon" server to enable it.';
		}

		return {
			phase: "tooling",
			status: "installing",
			nextAction: {
				type: "run_command",
				command: installCmd,
				description: `Installing Neon MCP server (${scope} scope) for ${mcpAgentId}.${enableNote}`,
				timeout: 60000,
				onSuccess: {
					type: "run_neon_init",
					args: [
						"skills",
						"--json",
						...(options.agent ? ["--agent", options.agent] : []),
						"--install",
					],
				},
				onFailure: {
					other: {
						type: "ask_user",
						question:
							"Failed to install the Neon MCP server automatically. Would you like to try again or configure it manually?",
						options: [
							{ value: "retry", label: "Try again" },
							{
								value: "manual",
								label: "I'll configure it manually",
							},
						],
						responseMapping: {
							retry: {
								args: [
									"mcp",
									"--json",
									...(options.agent
										? ["--agent", options.agent]
										: []),
									"--install",
								],
							},
							manual: {
								args: agentArgs,
							},
						},
					},
				},
			},
		};
	}

	// Agent reported detection result via --mcp-configured
	if (options.mcpConfigured === true) {
		// MCP is done — chain to skills installation (not back to orchestrator,
		// which would re-check MCP and loop since skills aren't installed yet).
		return {
			phase: "tooling",
			status: "mcp_configured",
			nextAction: {
				type: "run_neon_init",
				args: [
					"skills",
					"--json",
					...(options.agent ? ["--agent", options.agent] : []),
					"--install",
				],
			},
		};
	}

	if (options.mcpConfigured === false) {
		return {
			phase: "tooling",
			status: "install_needed",
			nextAction: {
				type: "ask_user",
				question:
					"The Neon MCP server is not yet configured. Would you like to install it?",
				options: [
					{
						value: "defaults",
						label: "Yes, install with default settings",
					},
					{
						value: "project_scope",
						label: "Yes, install for this project only",
					},
					{ value: "skip", label: "Skip for now" },
				],
				context:
					"The Neon MCP server gives your AI assistant direct access to Neon database operations like creating projects, running queries, and managing branches." +
					(options.agent?.toLowerCase() === "cursor" ||
					options.editor?.toLowerCase() === "cursor"
						? " Note: Cursor disables project-level MCP servers by default. If you choose project scope, you will need to manually enable the Neon server in Cursor Settings > MCP. Global scope is recommended for Cursor."
						: ""),
				responseMapping: {
					defaults: {
						args: [
							"mcp",
							"--json",
							...(options.agent
								? ["--agent", options.agent]
								: []),
							"--install",
						],
					},
					project_scope: {
						args: [
							"mcp",
							"--json",
							...(options.agent
								? ["--agent", options.agent]
								: []),
							"--install",
							"--scope",
							"project",
						],
					},
					skip: {
						args: [
							"skills",
							"--json",
							...(options.agent
								? ["--agent", options.agent]
								: []),
							"--install",
						],
					},
				},
			},
		};
	}

	// Default: ask the agent to check
	return {
		phase: "tooling",
		status: "detection_needed",
		nextAction: {
			type: "agent_check",
			checks: [
				{
					id: "mcp_server",
					description:
						"Check if the Neon MCP server is already configured in your MCP server list",
					lookFor: [
						"An MCP server entry named 'Neon' or with URL containing 'mcp.neon.tech'",
					],
				},
			],
			reportBack: {
				type: "run_neon_init",
				args: [
					"mcp",
					"--json",
					...(options.agent ? ["--agent", options.agent] : []),
					"--mcp-configured",
					"<true|false>",
				],
			},
		},
	};
}
