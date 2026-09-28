import { delimiter, dirname, join, resolve } from "node:path";
import { detectProjectAgents } from "add-mcp";
import which from "which";

import {
	type AgentType,
	detectInstalledAgents,
	listMcpAgentIds,
	tryResolveAddMcpAgentId,
	uniqueAgentIds,
} from "../init/agents.js";

export type PluginsInstallScope = "global" | "project";

export type PluginsMappedTarget = {
	agents: AgentType[];
	target: string;
};

const PLUGINS_TARGET_BY_TYPE: { [K in AgentType]?: string } = {
	cursor: "cursor",
	vscode: "vscode",
	"claude-code": "claude-code",
	"claude-desktop": "claude-code",
	codex: "codex",
	"github-copilot-cli": "github-copilot",
	"grok-build": "grok",
};

const USER_SCOPE_ONLY_TARGETS = new Set(["vscode", "github-copilot", "grok"]);

// The plugins CLI installs these targets by running the agent's own CLI, so a config
// folder without the command fails with ENOENT. Other targets write files directly.
const PLUGINS_TARGET_COMMANDS: { [target: string]: string } = {
	"github-copilot": "copilot",
	grok: "grok",
};

export type MissingPluginsCommand = { agent: AgentType; command: string };

/** npx runs the plugins CLI with every `node_modules/.bin` from `cwd` up to the root ahead of PATH. */
const pluginsCommandSearchPath = (cwd: string, path: string): string => {
	const bins: string[] = [];
	let dir = resolve(cwd);
	for (;;) {
		bins.push(join(dir, "node_modules", ".bin"));
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	return [...bins, path].join(delimiter);
};

export const missingPluginsCommands = (
	agents: readonly AgentType[],
	options: { cwd: string; path?: string },
): MissingPluginsCommand[] => {
	const searchPath = pluginsCommandSearchPath(
		options.cwd,
		options.path ?? process.env.PATH ?? "",
	);
	const missing: MissingPluginsCommand[] = [];
	for (const agent of uniqueAgentIds(agents)) {
		const target = getPluginsTargetName(agent);
		const command =
			target === undefined ? undefined : PLUGINS_TARGET_COMMANDS[target];
		if (
			command !== undefined &&
			which.sync(command, { nothrow: true, path: searchPath }) === null
		) {
			missing.push({ agent, command });
		}
	}
	return missing;
};

export function getPluginsTargetName(agent: string): string | undefined {
	if (Object.prototype.hasOwnProperty.call(PLUGINS_TARGET_BY_TYPE, agent)) {
		return PLUGINS_TARGET_BY_TYPE[agent as AgentType];
	}
	const id = tryResolveAddMcpAgentId(agent);
	if (!id) return undefined;
	return PLUGINS_TARGET_BY_TYPE[id];
}

export function supportsPlugins(agent: string): boolean {
	return getPluginsTargetName(agent) !== undefined;
}

export function isUserScopeOnlyPluginsTarget(target: string): boolean {
	return USER_SCOPE_ONLY_TARGETS.has(target);
}

export const pluginsMappedAgents = (): AgentType[] =>
	listMcpAgentIds().filter((id) => supportsPlugins(id));

export const pluginsInstallableAgents = (
	scope: PluginsInstallScope,
): AgentType[] =>
	pluginsMappedAgents().filter((id) => {
		if (scope === "global") {
			return true;
		}
		const target = getPluginsTargetName(id);
		return target !== undefined && !isUserScopeOnlyPluginsTarget(target);
	});

export const detectPluginsAgents = async (options: {
	scope: PluginsInstallScope;
	cwd: string;
	detectInstalledAgents?: () => Promise<readonly AgentType[]>;
}): Promise<AgentType[]> => {
	const detected =
		options.scope === "project"
			? detectProjectAgents(options.cwd)
			: await (options.detectInstalledAgents ?? detectInstalledAgents)();
	return uniqueAgentIds(detected).filter((id) => supportsPlugins(id));
};

export const detectInstallablePluginsAgents = async (options: {
	scope: PluginsInstallScope;
	cwd: string;
}): Promise<AgentType[]> => {
	const installable = new Set(pluginsInstallableAgents(options.scope));
	const detected = await detectPluginsAgents(options);
	return detected.filter((id) => installable.has(id));
};

export const mappedPluginsTargets = (
	agents: readonly AgentType[],
	scope: PluginsInstallScope,
): PluginsMappedTarget[] => {
	const mapped: PluginsMappedTarget[] = [];
	const byTarget = new Map<string, PluginsMappedTarget>();
	for (const agent of agents) {
		const target = getPluginsTargetName(agent);
		if (target === undefined) {
			continue;
		}
		if (scope === "project" && isUserScopeOnlyPluginsTarget(target)) {
			continue;
		}
		const existing = byTarget.get(target);
		if (existing !== undefined) {
			if (!existing.agents.includes(agent)) {
				existing.agents.push(agent);
			}
			continue;
		}
		const row: PluginsMappedTarget = { agents: [agent], target };
		byTarget.set(target, row);
		mapped.push(row);
	}
	if (mapped.length === 0) {
		throw new Error(
			`None of the selected agents can install plugins. Supported agents: ${pluginsInstallableAgents(scope).join(", ")}`,
		);
	}
	return mapped;
};
