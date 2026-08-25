import {
	getAgentDisplayName,
	tryResolveAddMcpAgentId,
} from "../init/agents.js";
import type { AgentType } from "../mcp/agents.js";
import {
	agentChoicesFrom,
	type PickAgentsOptions,
	pickAgentsInteractively,
	resolveAgentSelection,
} from "../utils/agent_picker.js";
import {
	detectPluginsAgents,
	getPluginsTargetName,
	isUserScopeOnlyPluginsTarget,
	mappedPluginsTargets,
	type PluginsInstallScope,
	type PluginsMappedTarget,
	pluginsInstallableAgents,
	pluginsMappedAgents,
} from "./targets.js";

export type PluginsPlan = {
	scope: PluginsInstallScope;
	agents: AgentType[];
	skipped: AgentType[];
	userScopeSkipped: AgentType[];
	targets: PluginsMappedTarget[];
};

export type ResolvePluginsPlanOptions = {
	global: boolean;
	agents: readonly string[];
	yes: boolean;
	cwd: string;
	interactive: boolean;
	pickAgents?: (options: PickAgentsOptions) => Promise<AgentType[]>;
};

export const assertPluginsCanRun = (options: {
	yes: boolean;
	interactive: boolean;
	hasAgents: boolean;
}): void => {
	if (options.yes || options.interactive || options.hasAgents) {
		return;
	}
	throw new Error(
		"No interactive terminal. Pass -y to install into detected agents, or --agent <name>.",
	);
};

export async function resolvePluginsPlan(
	options: ResolvePluginsPlanOptions,
): Promise<PluginsPlan> {
	assertPluginsCanRun({
		yes: options.yes,
		interactive: options.interactive,
		hasAgents: options.agents.length > 0,
	});
	const prompt = options.interactive && !options.yes;
	const scope: PluginsInstallScope = options.global ? "global" : "project";
	const available = pluginsInstallableAgents(scope);
	const detected = await detectPluginsAgents({
		scope,
		cwd: options.cwd,
	});
	const selected = await resolveAgentSelection({
		specified: options.agents,
		choices: agentChoicesFrom(available, detected),
		detected,
		message:
			"Which coding agents should get the Neon plugin? (space to toggle, enter to confirm)",
		nonInteractiveMessage:
			scope === "project"
				? `No coding agents detected in this project. Pass --agent <name>. Supported agents: ${pluginsMappedAgents().join(", ")}`
				: `No coding agents detected. Pass --agent <name>. Supported agents: ${pluginsMappedAgents().join(", ")}`,
		resolveSpecified: (raw) => {
			if (raw === "*") {
				throw new Error(
					"neon plugins does not accept --agent *. Pass --agent <name> for each coding agent, or omit --agent to use detected agents.",
				);
			}
			const id = tryResolveAddMcpAgentId(raw);
			if (!id) {
				throw new Error(
					`Unknown agent: "${raw}". Supported agents: ${pluginsMappedAgents().join(", ")}`,
				);
			}
			return id;
		},
		pick: prompt
			? (options.pickAgents ?? pickAgentsInteractively)
			: undefined,
		interactive: prompt,
	});

	const agents: AgentType[] = [];
	const skipped: AgentType[] = [];
	const userScopeSkipped: AgentType[] = [];
	for (const id of selected) {
		const target = getPluginsTargetName(id);
		if (target === undefined) {
			skipped.push(id);
			continue;
		}
		if (scope === "project" && isUserScopeOnlyPluginsTarget(target)) {
			userScopeSkipped.push(id);
			continue;
		}
		agents.push(id);
	}

	if (agents.length === 0) {
		if (userScopeSkipped.length > 0 && skipped.length === 0) {
			const names = userScopeSkipped
				.map((id) => getAgentDisplayName(id))
				.join(", ");
			throw new Error(
				`${names}: plugins are user-level. Pass --global. Project-scoped agents: ${pluginsInstallableAgents("project").join(", ")}`,
			);
		}
		throw new Error(
			`None of the selected agents can install plugins. Supported agents: ${available.join(", ")}`,
		);
	}

	return {
		scope,
		agents,
		skipped,
		userScopeSkipped,
		targets: mappedPluginsTargets(agents, scope),
	};
}
