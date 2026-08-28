import { isAbsolute, join, relative, resolve } from "node:path";
import type { AgentType } from "../mcp/agents.js";
import { mcpInstallableAgents } from "../mcp/targets.js";
import { pluginsInstallableAgents } from "../plugins/targets.js";
import { skillsInstallableAgents } from "../skills/targets.js";
import { agentArgv } from "../utils/agent_flag.js";
import { getCliName } from "../utils/cli_name.js";
import {
	supportsSkills,
	tryResolveAddMcpAgentId,
	uniqueAgentIds,
} from "./agents.js";

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

export const bootstrapInitStep = (
	yes: boolean,
	agents: readonly AgentType[] = [],
): InitStep => [
	...(yes
		? (["bootstrap", ".", "--default"] as const)
		: (["bootstrap", "."] as const)),
	...agentArgv(agents),
];

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

export type PostScaffoldAction = "git" | "agent" | "install" | "link";

/** Linking a template with neon.ts requires installed dependencies because env pull evaluates it. */
export const postScaffoldActions = (input: {
	git: boolean;
	agentSetup: InitAgentSetup;
	install: boolean;
	link: boolean;
	hasNeonConfig: boolean;
}): PostScaffoldAction[] => {
	const actions: PostScaffoldAction[] = [];
	if (input.git) {
		actions.push("git");
	}
	if (input.agentSetup !== "skip") {
		actions.push("agent");
	}
	const canLink = input.link && !(input.hasNeonConfig && !input.install);
	const installBeforeLink = canLink && input.hasNeonConfig && input.install;
	if (installBeforeLink) {
		actions.push("install");
		actions.push("link");
		return actions;
	}
	if (canLink) {
		actions.push("link");
	}
	if (input.install) {
		actions.push("install");
	}
	return actions;
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

export const planToolingSteps = (
	tooling: YesAgentTooling,
	options: { yes: boolean; named: boolean },
): InitStep[] => {
	const prefix = options.yes ? (["-y"] as const) : [];
	const flagsFor = (ids: readonly AgentType[]): string[] =>
		options.named ? [...prefix, ...agentArgv(ids)] : [...prefix];
	switch (tooling.setup) {
		case "skip":
			return [];
		case "plugin":
			return [["plugins", ...flagsFor(tooling.agents)]];
		case "skills-mcp": {
			const steps: InitStep[] = [];
			if (tooling.skillsAgents.length > 0) {
				steps.push(["skills", ...flagsFor(tooling.skillsAgents)]);
			}
			if (tooling.mcpAgents.length > 0) {
				steps.push(["mcp", ...flagsFor(tooling.mcpAgents)]);
			}
			return steps;
		}
		default: {
			const _exhaustive: never = tooling;
			return _exhaustive;
		}
	}
};

export const noDetectedAgentsMessage = (input: {
	scope: "project" | "global";
	supported: readonly string[];
	fix: "run-without-yes" | "pass-yes";
	nameAgent?: boolean;
}): string => {
	const lead =
		input.scope === "project"
			? "No coding agents detected in this project."
			: "No coding agents detected.";
	const name = input.nameAgent === true;
	let hint: string;
	if (input.fix === "pass-yes") {
		const detected =
			input.scope === "project"
				? "Pass -y to use project folders, else the host CLI agent"
				: "Pass -y to use installed apps, else the host CLI agent";
		hint = name
			? `${detected}, --agent <name> to name them, or run from a terminal to pick one.`
			: `${detected}, or run from a terminal to pick one.`;
	} else {
		hint = name
			? "Pass --agent <name>, run this command from a supported agent, or omit -y in a terminal to pick one."
			: "Run this command from a supported agent, or omit -y in a terminal to pick one.";
	}
	return `${lead} ${hint} Supported agents: ${input.supported.join(", ")}`;
};

export const INIT_NEEDS_YES_OR_TERMINAL =
	"No interactive terminal. Pass -y to use defaults, or run this command in a terminal to pick.";

const UNKNOWN_AGENT_COMMANDS = ["link"] as const;

type UnknownAgentCommand = (typeof UNKNOWN_AGENT_COMMANDS)[number];

const unknownAgentArgHint = (
	command: UnknownAgentCommand,
	cliName: string,
): string =>
	`${cliName} ${command} has no --agent. Pass --project-id <id> to link without a TTY, or run ${cliName} ${command} in a terminal.`;

const BOOLEAN_FLAGS = new Set([
	"-y",
	"--yes",
	"--default",
	"--force",
	"-h",
	"--help",
	"-v",
	"--version",
	"--color",
	"--no-color",
	"--analytics",
	"--no-analytics",
	"--oauth",
	"--project",
	"--global",
	"--read-only",
	"--readonly",
	"--clear",
	"--checks",
	"--no-checks",
	"--env-pull",
	"--no-env-pull",
	"--no-agent-setup",
	"--no-link",
	"--list",
	"--list-templates",
	"--force-auth",
	"--no-force-auth",
]);

const isUnknownAgentCommand = (token: string): token is UnknownAgentCommand => {
	for (const command of UNKNOWN_AGENT_COMMANDS) {
		if (command === token) {
			return true;
		}
	}
	return false;
};

const commandFromArgv = (
	argv: readonly string[],
): UnknownAgentCommand | undefined => {
	let skipValue = false;
	for (const token of argv) {
		if (skipValue) {
			skipValue = false;
			continue;
		}
		if (token === "--") {
			break;
		}
		if (token.startsWith("-")) {
			const flag = token.split("=")[0];
			if (
				flag !== undefined &&
				!token.includes("=") &&
				!BOOLEAN_FLAGS.has(flag)
			) {
				skipValue = true;
			}
			continue;
		}
		if (isUnknownAgentCommand(token)) {
			return token;
		}
	}
	return undefined;
};

export const rewriteUnknownAgentArg = (input: {
	message: string;
	argv: readonly string[];
	cliName: string;
}): string | undefined => {
	if (
		input.message !== "Unknown argument: agent" &&
		input.message !== "Unknown argument: a"
	) {
		return undefined;
	}
	const command = commandFromArgv(input.argv);
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

export const initPluginAgents = (): AgentType[] =>
	pluginsInstallableAgents("project");

export const initSkillsMcpAgents = (): AgentType[] => {
	const plugin = new Set(initPluginAgents());
	return initYesSupportedAgents().filter((id) => !plugin.has(id));
};

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

	const globalMcp = new Set(mcpInstallableAgents("global"));
	const skillsAgents = agents.filter((id) => supportsSkills(id));
	const mcpAgents = agents.filter((id) => globalMcp.has(id));
	if (skillsAgents.length === 0 && mcpAgents.length === 0) {
		return { setup: "skip" };
	}
	return { setup: "skills-mcp", skillsAgents, mcpAgents };
};

export const planYesAgentSteps = (tooling: YesAgentTooling): InitStep[] =>
	planToolingSteps(tooling, { yes: true, named: false });

export const NAMED_AGENTS_UNSUPPORTED =
	"None of the selected agents can install the Neon plugin, skills, or MCP.";

export const NAMED_AGENTS_MIXED =
	"Cannot install the plugin and skills/MCP in one run.";

export type NamedAgentCommandContext = {
	directory?: string;
	yes?: boolean;
};

const quoteIfNeeded = (value: string): string =>
	/[\s"'\\]/.test(value)
		? `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`
		: value;

const mixedRerun = (
	command: "init" | "bootstrap",
	ids: readonly AgentType[],
	context?: NamedAgentCommandContext,
): string => {
	const tokens: string[] = [getCliName(), command];
	if (
		command === "bootstrap" &&
		context?.directory !== undefined &&
		context.directory.length > 0
	) {
		tokens.push(quoteIfNeeded(context.directory));
	}
	if (context?.yes === true) {
		tokens.push(command === "bootstrap" ? "--default" : "-y");
	}
	tokens.push(...ids.flatMap((id) => ["--agent", id]));
	return `\`${tokens.join(" ")}\``;
};

export const namedAgentsMixedMessage = (
	named: readonly AgentType[],
	command: "init" | "bootstrap",
	context?: NamedAgentCommandContext,
): string => {
	const plugin = new Set(initPluginAgents());
	const pluginNamed = uniqueAgentIds(named.filter((id) => plugin.has(id)));
	const otherNamed = uniqueAgentIds(named.filter((id) => !plugin.has(id)));
	return `${NAMED_AGENTS_MIXED} Plugin: ${pluginNamed.join(", ")}. Skills/MCP: ${otherNamed.join(", ")}. Re-run ${mixedRerun(command, pluginNamed, context)} or ${mixedRerun(command, otherNamed, context)}.`;
};

export const namedAgentsNeedSplit = (
	named: readonly AgentType[],
	tooling: YesAgentTooling,
): boolean => {
	if (tooling.setup === "skip") {
		return false;
	}
	if (tooling.setup === "plugin") {
		const used = new Set<AgentType>(tooling.agents);
		const leftover = named.filter((id) => !used.has(id));
		return chooseYesAgentTooling(leftover).setup !== "skip";
	}
	const used = new Set<AgentType>([
		...tooling.skillsAgents,
		...tooling.mcpAgents,
	]);
	return named.some((id) => !used.has(id));
};

export const assertNamedAgentTooling = (
	named: readonly AgentType[],
	command: "init" | "bootstrap" = "init",
	context?: NamedAgentCommandContext,
): void => {
	if (named.length === 0) {
		return;
	}
	const tooling = chooseYesAgentTooling(named);
	if (tooling.setup === "skip") {
		throw new Error(
			`${NAMED_AGENTS_UNSUPPORTED} Supported agents: ${initYesSupportedAgents().join(", ")}`,
		);
	}
	if (namedAgentsNeedSplit(named, tooling)) {
		throw new Error(namedAgentsMixedMessage(named, command, context));
	}
};

export const resolveNamedAgents = (raw: readonly string[]): AgentType[] => {
	if (raw.length === 0) {
		return [];
	}
	const available = initYesSupportedAgents();
	const resolved: AgentType[] = [];
	for (const item of raw) {
		if (item === "*") {
			throw new Error(
				"--agent * is not accepted. Pass --agent <name> for each coding agent, or omit --agent to detect or pick.",
			);
		}
		const id = tryResolveAddMcpAgentId(item);
		if (!id) {
			throw new Error(
				`Unknown agent: "${item}". Supported agents: ${available.join(", ")}`,
			);
		}
		resolved.push(id);
	}
	return uniqueAgentIds(resolved);
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
