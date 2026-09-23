import {
	MCP_CONFIG_LOCATION_PROJECT_CONFLICT,
	MCP_SCOPED_AND_PROJECT_ID,
	MCP_SCOPED_NEEDS_PROJECT,
} from "../init/copy.js";
import { detectAgent } from "../init/detect_host.js";
import { collectYesAgents, noDetectedAgentsMessage } from "../init/plan.js";
import {
	agentChoicesFrom,
	type PickAgentsOptions,
	pickAgentsInteractively,
	resolveAgentSelection,
} from "../utils/agent_picker.js";
import { type AgentType, tryResolveAddMcpAgentId } from "./agents.js";
import type { McpInstallScope, NeonMcpCategory } from "./install.js";
import { detectMcpAgents, mcpInstallableAgents } from "./targets.js";
import { type McpAuthKind, pickMcpAuth, pickMcpScope } from "./wizard.js";

export type { McpAuthKind };

export type McpConfigLocation = "global" | "project";

export type McpPlan = {
	scope: McpInstallScope;
	agents: AgentType[];
	auth: McpAuthKind;
	readOnly: boolean;
	urlProjectId: string | undefined;
	categories: readonly NeonMcpCategory[];
};

export type ResolveMcpPlanOptions = {
	mcpConfigLocation?: McpConfigLocation;
	project: boolean;
	mcpProjectScoped: boolean;
	oauth: boolean;
	agents: readonly string[];
	yes: boolean;
	cwd: string;
	interactive: boolean;
	readOnly: boolean;
	projectId?: string;
	categories: readonly NeonMcpCategory[];
	linkedProjectId?: string;
	pickScope?: () => Promise<McpInstallScope>;
	pickAgents?: (options: PickAgentsOptions) => Promise<AgentType[]>;
	pickAuth?: () => Promise<McpAuthKind>;
	detectAgent?: () => AgentType | null;
};

const resolveMcpConfigLocation = async (
	options: ResolveMcpPlanOptions,
	prompt: boolean,
): Promise<McpInstallScope> => {
	if (options.mcpConfigLocation !== undefined) {
		return options.mcpConfigLocation;
	}
	if (options.project) {
		return "project";
	}
	if (prompt) {
		return await (options.pickScope ?? pickMcpScope)();
	}
	return "global";
};

const resolveMcpUrlProjectId = (
	options: ResolveMcpPlanOptions,
): string | undefined => {
	if (options.mcpProjectScoped) {
		if (
			options.linkedProjectId === undefined ||
			options.linkedProjectId.length === 0
		) {
			throw new Error(MCP_SCOPED_NEEDS_PROJECT);
		}
		return options.linkedProjectId;
	}
	return options.projectId;
};

export async function resolveMcpPlan(
	options: ResolveMcpPlanOptions,
): Promise<McpPlan> {
	if (options.mcpConfigLocation === "global" && options.project) {
		throw new Error(MCP_CONFIG_LOCATION_PROJECT_CONFLICT);
	}
	if (options.mcpProjectScoped && options.projectId !== undefined) {
		throw new Error(MCP_SCOPED_AND_PROJECT_ID);
	}
	const prompt = options.interactive && !options.yes;
	const scope = await resolveMcpConfigLocation(options, prompt);

	const available = mcpInstallableAgents(scope);
	const availableSet = new Set(available);
	const scoped = await detectMcpAgents({ scope, cwd: options.cwd });
	const detected =
		options.yes && options.agents.length === 0
			? await collectYesAgents({
					detected: () => scoped,
					detectAgent: options.detectAgent ?? detectAgent,
					acceptHost: (id) => availableSet.has(id),
				})
			: scoped;
	const agents = await resolveAgentSelection({
		specified: options.agents,
		choices: agentChoicesFrom(available, detected),
		detected,
		message:
			"Which coding agents should get the Neon MCP server? (space to toggle, enter to confirm)",
		nonInteractiveMessage: noDetectedAgentsMessage({
			scope,
			supported: available,
			fix: options.yes ? "run-without-yes" : "pass-yes",
			nameAgent: true,
		}),
		resolveSpecified: (raw) => {
			const id = tryResolveAddMcpAgentId(raw);
			if (!id) {
				throw new Error(
					`Unknown agent: "${raw}". Supported agents: ${available.join(", ")}`,
				);
			}
			return id;
		},
		pick: prompt
			? (options.pickAgents ?? pickAgentsInteractively)
			: undefined,
		interactive: prompt,
	});

	const auth: McpAuthKind = options.oauth
		? "oauth"
		: prompt
			? await (options.pickAuth ?? pickMcpAuth)()
			: "api-key";

	return {
		scope,
		agents,
		auth,
		readOnly: options.readOnly,
		urlProjectId: resolveMcpUrlProjectId(options),
		categories: options.categories,
	};
}
