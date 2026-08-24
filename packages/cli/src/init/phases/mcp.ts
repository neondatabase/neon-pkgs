import { installNeonMcpServer } from "../../mcp/install.js";
import {
	agentSupportsHttpMcp,
	agentSupportsProjectMcp,
	getAgentDisplayName,
	getSkillsAgentName,
	resolveAddMcpAgentId,
	tryResolveAddMcpAgentId,
} from "../agents.js";
import { isAuthenticated } from "../auth.js";
import type { PhaseResponse } from "../types.js";

export type McpPhaseOptions = {
	agent?: string;
	editor?: string;
	status?: boolean;
	install?: boolean;
	scope?: "global" | "project";
	mcpConfigured?: boolean | null;
};

function skillsFollowUp(agent: string | undefined): string[] {
	if (agent && !getSkillsAgentName(agent)) {
		return agent ? ["--agent", agent, "--json"] : ["--json"];
	}
	return [
		"skills",
		"--json",
		...(agent ? ["--agent", agent] : []),
		"--install",
	];
}

export async function handleMcpPhase(
	options: McpPhaseOptions,
): Promise<PhaseResponse> {
	const agentArgs = options.agent
		? ["--agent", options.agent, "--json"]
		: ["--json"];

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

		const scope = options.scope ?? "global";
		const mcpAgentId = resolveAddMcpAgentId(options.agent ?? "claude-code");
		const installed = installNeonMcpServer({
			agent: mcpAgentId,
			scope,
			cwd: process.cwd(),
		});

		if (!installed.ok) {
			if (installed.unsupported) {
				if (
					scope === "project" &&
					!agentSupportsProjectMcp(mcpAgentId) &&
					agentSupportsHttpMcp(mcpAgentId)
				) {
					return {
						phase: "tooling",
						status: "unsupported",
						error: installed.error,
						nextAction: {
							type: "ask_user",
							question: `${getAgentDisplayName(mcpAgentId)} does not support project-level MCP. Install the Neon MCP server globally instead?`,
							options: [
								{
									value: "global",
									label: "Install globally",
								},
								{
									value: "skip",
									label: "Skip MCP install",
								},
							],
							responseMapping: {
								global: {
									args: [
										"mcp",
										"--json",
										...(options.agent
											? ["--agent", options.agent]
											: []),
										"--install",
									],
								},
								skip: {
									args: skillsFollowUp(options.agent),
								},
							},
						},
					};
				}
				return {
					phase: "tooling",
					status: "unsupported",
					error: installed.error,
					nextAction: {
						type: "run_neon_init",
						args: skillsFollowUp(options.agent),
					},
				};
			}
			return {
				phase: "tooling",
				status: "failed",
				error: installed.error,
				nextAction: {
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
								...(scope === "project"
									? ["--scope", "project"]
									: []),
							],
						},
						manual: {
							args: agentArgs,
						},
					},
				},
			};
		}

		const isCursor =
			mcpAgentId === "cursor" ||
			options.agent?.toLowerCase() === "cursor";
		const isClaudeCode =
			mcpAgentId === "claude-code" ||
			options.agent?.toLowerCase() === "claude-code";
		let enableNote = "";
		if (isCursor && scope === "project") {
			enableNote =
				' Cursor disables project-level MCP servers by default — open Cursor Settings > MCP and toggle the "Neon" server on.';
		} else if (isClaudeCode) {
			enableNote =
				' Claude Code requires approval for newly added MCP servers. When prompted, approve the "Neon" server to enable it.';
		}

		return {
			phase: "tooling",
			status: "installed",
			path: installed.path,
			nextAction: {
				type: "run_neon_init",
				args: skillsFollowUp(options.agent),
			},
			message: `Installed Neon MCP server (${scope} scope) for ${mcpAgentId}.${enableNote}`,
		};
	}

	if (options.mcpConfigured === true) {
		return {
			phase: "tooling",
			status: "mcp_configured",
			nextAction: {
				type: "run_neon_init",
				args: skillsFollowUp(options.agent),
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
					...(() => {
						const known = options.agent
							? tryResolveAddMcpAgentId(options.agent)
							: undefined;
						if (known && !agentSupportsProjectMcp(known)) {
							return [];
						}
						return [
							{
								value: "project_scope",
								label: "Yes, install for this project only",
							},
						];
					})(),
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
						args: skillsFollowUp(options.agent),
					},
				},
			},
		};
	}

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
