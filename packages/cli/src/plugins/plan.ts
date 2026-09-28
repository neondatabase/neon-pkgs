import {
	getAgentDisplayName,
	tryResolveAddMcpAgentId,
} from "../init/agents.js";
import { detectAgent } from "../init/detect_host.js";
import { collectYesAgents, noDetectedAgentsMessage } from "../init/plan.js";
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
	type MissingPluginsCommand,
	mappedPluginsTargets,
	missingPluginsCommands,
	type PluginsInstallScope,
	type PluginsMappedTarget,
	pluginsInstallableAgents,
} from "./targets.js";

export type PluginsPlan = {
	scope: PluginsInstallScope;
	agents: AgentType[];
	skipped: AgentType[];
	userScopeSkipped: AgentType[];
	/** Detected agents left out because the plugins CLI needs their command. */
	missingCommands: MissingPluginsCommand[];
	targets: PluginsMappedTarget[];
};

export type ResolvePluginsPlanOptions = {
	global: boolean;
	agents: readonly string[];
	yes: boolean;
	cwd: string;
	interactive: boolean;
	pickAgents?: (options: PickAgentsOptions) => Promise<AgentType[]>;
	detectAgent?: () => AgentType | null;
	detectInstalledAgents?: () => Promise<readonly AgentType[]>;
	/** PATH to look up agent commands in. Defaults to `process.env.PATH`. */
	commandPath?: string;
};

export const missingPluginsCommandsError = (
	missing: readonly MissingPluginsCommand[],
): Error =>
	new Error(
		missing
			.map(
				({ agent, command }) =>
					`Cannot install the Neon plugin for ${getAgentDisplayName(agent)}: "${command}" was not found on PATH. Install it or add it to PATH, then retry.`,
			)
			.join("\n"),
	);

export const assertPluginsCanRun = (options: {
	yes: boolean;
	interactive: boolean;
	hasAgents: boolean;
}): void => {
	if (options.yes || options.interactive || options.hasAgents) {
		return;
	}
	throw new Error(
		"No interactive terminal. Pass -y to install into detected agents, or --agent <name> to name them.",
	);
};

const commandLookup = (
	options: ResolvePluginsPlanOptions,
): { cwd: string; path?: string } => ({
	cwd: options.cwd,
	...(options.commandPath !== undefined ? { path: options.commandPath } : {}),
});

const withoutMissingPluginsCommands = (
	agents: readonly AgentType[],
	options: ResolvePluginsPlanOptions,
): AgentType[] => {
	const missing = new Set(
		missingPluginsCommands(agents, commandLookup(options)).map(
			(row) => row.agent,
		),
	);
	return agents.filter((id) => !missing.has(id));
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
	const availableSet = new Set(available);
	const scoped = await detectPluginsAgents({
		scope,
		cwd: options.cwd,
		...(options.detectInstalledAgents
			? { detectInstalledAgents: options.detectInstalledAgents }
			: {}),
	});
	const detected =
		options.yes && options.agents.length === 0
			? await collectYesAgents({
					detected: () => scoped,
					detectAgent: options.detectAgent ?? detectAgent,
					acceptHost: (id) =>
						availableSet.has(id) ||
						getPluginsTargetName(id) !== undefined,
				})
			: scoped;
	// The picker preselects only agents whose plugin can install; `-y` keeps the full
	// list so it can warn about the ones it skips.
	const preselected = prompt
		? withoutMissingPluginsCommands(detected, options)
		: detected;
	const selected = await resolveAgentSelection({
		specified: options.agents,
		choices: agentChoicesFrom(available, preselected),
		detected: preselected,
		message:
			"Which coding agents should get the Neon plugin? (space to toggle, enter to confirm)",
		nonInteractiveMessage: noDetectedAgentsMessage({
			scope,
			supported: available,
			fix: options.yes ? "run-without-yes" : "pass-yes",
			nameAgent: true,
		}),
		resolveSpecified: (raw) => {
			if (raw === "*") {
				throw new Error(
					"neon plugins does not accept --agent *. Pass --agent <name> for each coding agent, or omit --agent to use detected agents.",
				);
			}
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

	const missingCommands = missingPluginsCommands(
		agents,
		commandLookup(options),
	);
	if (missingCommands.length > 0) {
		const detectedOnly = options.agents.length === 0 && !prompt;
		if (!detectedOnly) {
			throw missingPluginsCommandsError(missingCommands);
		}
		const missingAgents = new Set(missingCommands.map((row) => row.agent));
		const installable = agents.filter((id) => !missingAgents.has(id));
		return {
			scope,
			agents: installable,
			skipped,
			userScopeSkipped,
			missingCommands,
			targets:
				installable.length === 0
					? []
					: mappedPluginsTargets(installable, scope),
		};
	}

	if (agents.length === 0) {
		if (userScopeSkipped.length > 0 && skipped.length === 0) {
			const names = userScopeSkipped
				.map((id) => getAgentDisplayName(id))
				.join(", ");
			throw new Error(
				`${names}: plugins are user-level. Pass --global. Without --global: ${pluginsInstallableAgents("project").join(", ")}`,
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
		missingCommands,
		targets: mappedPluginsTargets(agents, scope),
	};
}
