import { isAbsolute, join, relative, resolve } from "node:path";
import type { AgentType } from "../mcp/agents.js";
import { mcpInstallableAgents } from "../mcp/targets.js";
import { pluginsInstallableAgents } from "../plugins/targets.js";
import { skillsInstallableAgents } from "../skills/targets.js";
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

export const noDetectedAgentsMessage = (input: {
	scope: "project" | "global";
	supported: readonly string[];
	fix: "run-without-yes" | "pass-yes";
}): string => {
	const lead =
		input.scope === "project"
			? "No coding agents detected in this project."
			: "No coding agents detected.";
	const hint =
		input.fix === "pass-yes"
			? input.scope === "project"
				? "Pass -y to use project folders, else the host CLI agent, or run from a terminal to pick one."
				: "Pass -y to use installed apps, else the host CLI agent, or run from a terminal to pick one."
			: "Run this command from a supported agent, or omit -y in a terminal to pick one.";
	return `${lead} ${hint} Supported agents: ${input.supported.join(", ")}`;
};

export const INIT_NEEDS_YES_OR_TERMINAL =
	"No interactive terminal. Pass -y to use defaults, or run this command in a terminal to pick.";

const UNKNOWN_AGENT_COMMANDS = [
	"bootstrap",
	"init",
	"link",
	"mcp",
	"plugins",
	"skills",
] as const;

type UnknownAgentCommand = (typeof UNKNOWN_AGENT_COMMANDS)[number];

const unknownAgentArgHint = (
	command: UnknownAgentCommand,
	cliName: string,
): string => {
	const invocation = `${cliName} ${command}`;
	switch (command) {
		case "link":
			return `${invocation} has no --agent. Pass --project-id <id> to link without a TTY, or run ${invocation} in a terminal.`;
		case "bootstrap":
			return `${invocation} has no --agent. Pass --template <id> and --default, or run ${invocation} in a terminal.`;
		default:
			return `${invocation} has no --agent. Pass -y to use detected agents, or run ${invocation} in a terminal to pick.`;
	}
};

export const rewriteUnknownAgentArg = (input: {
	message: string;
	argv: readonly string[];
	cliName: string;
}): string | undefined => {
	if (input.message !== "Unknown argument: agent") {
		return undefined;
	}
	const command = UNKNOWN_AGENT_COMMANDS.find((cmd) =>
		input.argv.includes(cmd),
	);
	if (command === undefined) {
		return undefined;
	}
	return unknownAgentArgHint(command, input.cliName);
};

export const initYesSupportedAgents = (): AgentType[] =>
	uniqueAgentIds([
		...pluginsInstallableAgents("project"),
		...skillsInstallableAgents(),
		...mcpInstallableAgents("global"),
	]);

export const resolveYesAgentList = (input: {
	detected: readonly AgentType[];
	host: AgentType | null;
}): AgentType[] => {
	if (input.detected.length > 0) {
		return uniqueAgentIds(input.detected);
	}
	if (input.host !== null) {
		return [input.host];
	}
	return [];
};

export async function collectYesAgents(sources: {
	detected: () => readonly AgentType[] | Promise<readonly AgentType[]>;
	detectAgent: () => AgentType | null;
	acceptHost?: (id: AgentType) => boolean;
}): Promise<AgentType[]> {
	const detected = await sources.detected();
	if (detected.length > 0) {
		return resolveYesAgentList({ detected, host: null });
	}
	const rawHost = sources.detectAgent();
	const accept = sources.acceptHost ?? (() => true);
	const host = rawHost !== null && accept(rawHost) ? rawHost : null;
	return resolveYesAgentList({ detected, host });
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

	const projectMcp = new Set(mcpInstallableAgents("project"));
	const skillsAgents = agents.filter((id) => supportsSkills(id));
	const mcpAgents = agents.filter((id) => projectMcp.has(id));
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
			return [["plugins", "-y"]];
		case "skills-mcp": {
			const steps: InitStep[] = [];
			if (tooling.skillsAgents.length > 0) {
				steps.push(["skills", "-y"]);
			}
			if (tooling.mcpAgents.length > 0) {
				steps.push(["mcp", "-y", "--project"]);
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
	throw new Error(INIT_NEEDS_YES_OR_TERMINAL);
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
