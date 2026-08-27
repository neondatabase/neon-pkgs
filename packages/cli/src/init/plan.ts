import { isAbsolute, join, relative, resolve } from "node:path";
import type { AgentType } from "../mcp/agents.js";
import { mcpInstallableAgents } from "../mcp/targets.js";
import { pluginsInstallableAgents } from "../plugins/targets.js";
import { supportsSkills, uniqueAgentIds } from "./agents.js";

export type InitAgentSetup = "plugin" | "skills-mcp" | "skip";

export type YesAgentTooling =
	| { setup: "plugin"; agents: [AgentType, ...AgentType[]] }
	| {
			setup: "skills-mcp";
			skillsAgents: readonly AgentType[];
			mcpAgents: readonly AgentType[];
	  }
	| { setup: "skip" };

export type InitStep = readonly string[];

export const directoryIsEmpty = (names: readonly string[]): boolean =>
	names.filter((name) => name !== ".git").length === 0;

export const bootstrapInitStep = (yes: boolean): InitStep =>
	yes ? ["bootstrap", ".", "--default"] : ["bootstrap", "."];

export const projectContextFile = (
	projectDir: string,
	contextFile: string,
): string => {
	const resolved = isAbsolute(contextFile)
		? contextFile
		: resolve(projectDir, contextFile);
	const rel = relative(projectDir, resolved);
	if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
		return join(projectDir, ".neon");
	}
	return resolved;
};

export const planAgentSteps = (input: {
	yes: boolean;
	agentSetup: InitAgentSetup;
}): InitStep[] => {
	const y = input.yes ? (["-y"] as const) : [];
	if (input.agentSetup === "plugin") {
		return [["plugins", ...y]];
	}
	if (input.agentSetup === "skills-mcp") {
		return [
			["skills", ...y],
			["mcp", ...y],
		];
	}
	return [];
};

const agentFlags = (ids: readonly AgentType[]): string[] =>
	ids.flatMap((id) => ["--agent", id]);

export const resolveYesAgentList = (input: {
	project: readonly AgentType[];
	host: AgentType | null;
	installed: readonly AgentType[];
}): AgentType[] => {
	if (input.project.length > 0) {
		return uniqueAgentIds(input.project);
	}
	if (input.host !== null) {
		return [input.host];
	}
	return uniqueAgentIds(input.installed);
};

export async function collectYesAgents(sources: {
	project: () => readonly AgentType[] | Promise<readonly AgentType[]>;
	detectAgent: () => AgentType | null;
	detectInstalled: () => Promise<readonly AgentType[]>;
	acceptHost?: (id: AgentType) => boolean;
}): Promise<AgentType[]> {
	const project = await sources.project();
	if (project.length > 0) {
		return resolveYesAgentList({
			project,
			host: null,
			installed: [],
		});
	}
	const rawHost = sources.detectAgent();
	const accept = sources.acceptHost ?? (() => true);
	const host = rawHost !== null && accept(rawHost) ? rawHost : null;
	if (host !== null) {
		return resolveYesAgentList({
			project,
			host,
			installed: [],
		});
	}
	const installed = await sources.detectInstalled();
	return resolveYesAgentList({
		project,
		host: null,
		installed,
	});
}

export const chooseYesAgentTooling = (
	agents: readonly AgentType[],
): YesAgentTooling => {
	const projectPlugin = new Set(pluginsInstallableAgents("project"));
	const pluginAgents = agents.filter((id) => projectPlugin.has(id));
	const [pluginFirst, ...pluginRest] = pluginAgents;
	if (pluginFirst !== undefined) {
		return { setup: "plugin", agents: [pluginFirst, ...pluginRest] };
	}

	const globalMcp = new Set(mcpInstallableAgents("global"));
	const skillsAgents = agents.filter((id) => supportsSkills(id));
	const mcpAgents = agents.filter((id) => globalMcp.has(id));
	if (skillsAgents.length === 0 && mcpAgents.length === 0) {
		return { setup: "skip" };
	}
	return { setup: "skills-mcp", skillsAgents, mcpAgents };
};

export const planYesAgentSteps = (tooling: YesAgentTooling): InitStep[] => {
	switch (tooling.setup) {
		case "skip":
			return [];
		case "plugin":
			return [["plugins", "-y", ...agentFlags(tooling.agents)]];
		case "skills-mcp": {
			const steps: InitStep[] = [];
			if (tooling.skillsAgents.length > 0) {
				steps.push([
					"skills",
					"-y",
					...agentFlags(tooling.skillsAgents),
				]);
			}
			if (tooling.mcpAgents.length > 0) {
				steps.push(["mcp", "-y", ...agentFlags(tooling.mcpAgents)]);
			}
			return steps;
		}
		default: {
			const _exhaustive: never = tooling;
			return _exhaustive;
		}
	}
};

export const planExistingInit = (input: {
	linked: boolean;
	yes: boolean;
	agentSetup: InitAgentSetup;
}): InitStep[] => {
	const steps: InitStep[] = [...planAgentSteps(input)];
	if (!input.linked) {
		steps.push(input.yes ? ["link", "--yes"] : ["link"]);
	}
	steps.push(
		input.yes
			? ["config", "init", "--services", "none"]
			: ["config", "init"],
	);
	return steps;
};

export const resolveInitAgentSetup = async (input: {
	interactive: boolean;
	pick: () => Promise<InitAgentSetup>;
}): Promise<InitAgentSetup> => {
	if (input.interactive) {
		return input.pick();
	}
	return "skills-mcp";
};

export type ChildForward = {
	configDir?: string;
	profile?: string;
	apiHost: string;
	contextFile: string;
	analytics?: boolean;
};

export const childArgv = (step: InitStep, forward: ChildForward): string[] => {
	const args = [...step];
	if (forward.configDir) {
		args.push("--config-dir", forward.configDir);
	}
	if (forward.profile) {
		args.push("--profile", forward.profile);
	}
	args.push("--api-host", forward.apiHost);
	args.push("--context-file", forward.contextFile);
	if (forward.analytics === false) {
		args.push("--no-analytics");
	}
	return args;
};
