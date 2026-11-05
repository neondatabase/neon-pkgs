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
	mappedPluginsTargets,
	missingPluginsCommands,
	type PluginsMappedTarget,
	pluginsCommandFix,
	pluginsCommandProblemText,
	pluginsInstallableAgents,
	type UnusablePluginsCommand,
	unusablePluginsCommands,
} from "./targets.js";

export type PluginsPlan = {
	agents: AgentType[];
	skipped: AgentType[];
	/** Detected agents left out because the plugins CLI needs their command. */
	unusableCommands: UnusablePluginsCommand[];
	targets: PluginsMappedTarget[];
};

/** Where `-y` looks for agents. Plugins always install user-level. */
export type PluginsDetectFrom = "project" | "installed";

export type ResolvePluginsPlanOptions = {
	detectFrom: PluginsDetectFrom;
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

export const unusablePluginsCommandsError = (
	unusable: readonly UnusablePluginsCommand[],
): Error =>
	new Error(
		unusable
			.map(
				(row) =>
					`Cannot install the Neon plugin for ${getAgentDisplayName(row.agent)}: "${row.command.name}" ${pluginsCommandProblemText(row)}. ${pluginsCommandFix(row)}, then retry.`,
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

export async function resolvePluginsPlan(
	options: ResolvePluginsPlanOptions,
): Promise<PluginsPlan> {
	assertPluginsCanRun({
		yes: options.yes,
		interactive: options.interactive,
		hasAgents: options.agents.length > 0,
	});
	const prompt = options.interactive && !options.yes;
	const detectScope =
		options.detectFrom === "installed" ? "global" : "project";
	const available = pluginsInstallableAgents("global");
	const availableSet = new Set(available);
	const scoped = await detectPluginsAgents({
		scope: detectScope,
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
	// The picker keeps detected agents first but checks only the ones whose plugin can
	// install; `-y` keeps the full list so it can warn about the ones it skips. Detected
	// agents are not run here: only the ones selected below are probed.
	const unusableDetected = new Map(
		(prompt && options.agents.length === 0
			? missingPluginsCommands(detected, commandLookup(options))
			: []
		).map((row) => [row.agent, row]),
	);
	const choices = agentChoicesFrom(available, detected).map((choice) => {
		const row = unusableDetected.get(choice.id);
		return row === undefined
			? choice
			: {
					...choice,
					description: `detected, but "${row.command.name}" ${pluginsCommandProblemText(row)}`,
				};
	});
	const selected = await resolveAgentSelection({
		specified: options.agents,
		choices,
		detected: detected.filter((id) => !unusableDetected.has(id)),
		message:
			"Which coding agents should get the Neon plugin? (space to toggle, enter to confirm)",
		nonInteractiveMessage: noDetectedAgentsMessage({
			scope: detectScope,
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
	for (const id of selected) {
		if (getPluginsTargetName(id) === undefined) {
			skipped.push(id);
			continue;
		}
		agents.push(id);
	}

	const unusableCommands = unusablePluginsCommands(
		agents,
		commandLookup(options),
	);
	if (unusableCommands.length > 0) {
		const detectedOnly = options.agents.length === 0 && !prompt;
		if (!detectedOnly) {
			throw unusablePluginsCommandsError(unusableCommands);
		}
		const missingAgents = new Set(unusableCommands.map((row) => row.agent));
		const installable = agents.filter((id) => !missingAgents.has(id));
		return {
			agents: installable,
			skipped,
			unusableCommands,
			targets:
				installable.length === 0
					? []
					: mappedPluginsTargets(installable, "global"),
		};
	}

	if (agents.length === 0) {
		throw new Error(
			`None of the selected agents can install plugins. Supported agents: ${available.join(", ")}`,
		);
	}

	return {
		agents,
		skipped,
		unusableCommands,
		targets: mappedPluginsTargets(agents, "global"),
	};
}
