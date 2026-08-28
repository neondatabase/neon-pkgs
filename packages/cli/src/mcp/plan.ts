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
import {
	type McpAuthKind,
	pickMcpAuth,
	pickMcpProjectPin,
	pickMcpScope,
} from "./wizard.js";

export type { McpAuthKind };

export type McpPlan = {
	scope: McpInstallScope;
	agents: AgentType[];
	auth: McpAuthKind;
	readOnly: boolean;
	urlProjectId: string | undefined;
	categories: readonly NeonMcpCategory[];
};

export type ResolveMcpPlanOptions = {
	project: boolean;
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
	pickProjectPin?: (
		linkedProjectId: string,
		willMintKey: boolean,
	) => Promise<boolean>;
	detectAgent?: () => AgentType | null;
};

export async function resolveMcpPlan(
	options: ResolveMcpPlanOptions,
): Promise<McpPlan> {
	const prompt = options.interactive && !options.yes;
	const scope: McpInstallScope = options.project
		? "project"
		: prompt
			? await (options.pickScope ?? pickMcpScope)()
			: "global";

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

	let urlProjectId = options.projectId;
	if (
		urlProjectId === undefined &&
		prompt &&
		scope === "project" &&
		options.linkedProjectId
	) {
		const pin = await (options.pickProjectPin ?? pickMcpProjectPin)(
			options.linkedProjectId,
			auth === "api-key",
		);
		if (pin) {
			urlProjectId = options.linkedProjectId;
		}
	}

	return {
		scope,
		agents,
		auth,
		readOnly: options.readOnly,
		urlProjectId,
		categories: options.categories,
	};
}
