import { spawnSync } from "node:child_process";
import { delimiter, dirname, join, resolve } from "node:path";
import which from "which";

import {
	type AgentType,
	detectInstalledAgents,
	detectProjectAgents,
	listMcpAgentIds,
	tryResolveAddMcpAgentId,
	uniqueAgentIds,
} from "../init/agents.js";
import { pluginsChildEnv } from "./child_env.js";

export type PluginsInstallScope = "global" | "project";

export type PluginsMappedTarget = {
	agents: AgentType[];
	target: string;
};

/**
 * An agent CLI the plugins CLI runs to install into that agent. `versionPrefix` is what
 * `--version` prints right before the version; `minVersion` is the first release whose
 * plugin commands accept the plugins CLI's calls.
 */
export type PluginsCommand = {
	name: string;
	product: string;
	versionPrefix: string;
	minVersion?: string;
};

/**
 * A plugins CLI target and what installing into it needs. With `command`, the plugins CLI
 * runs that agent CLI and fails when it is missing or broken; without one, it writes
 * files. `e2e/plugins.e2e.test.ts` checks every entry against the real plugins CLI.
 */
export type PluginsTarget = { target: string; command?: PluginsCommand };

const CLAUDE_CODE: PluginsTarget = { target: "claude-code" };

const PLUGINS_TARGET_BY_TYPE: { [K in AgentType]?: PluginsTarget } = {
	cursor: { target: "cursor" },
	vscode: { target: "vscode" },
	"claude-code": CLAUDE_CODE,
	"claude-desktop": CLAUDE_CODE,
	codex: { target: "codex" },
	// 0.0.399 and earlier reject `copilot plugin install <name>@<marketplace>`.
	"github-copilot-cli": {
		target: "github-copilot",
		command: {
			name: "copilot",
			product: "GitHub Copilot CLI",
			versionPrefix: "GitHub Copilot CLI",
			minVersion: "0.0.400",
		},
	},
	"grok-build": {
		target: "grok",
		command: { name: "grok", product: "Grok Build", versionPrefix: "grok" },
	},
	"kimi-code": { target: "kimi" },
};

export const pluginsTargets = (): PluginsTarget[] => [
	...new Set(Object.values(PLUGINS_TARGET_BY_TYPE)),
];

const USER_SCOPE_ONLY_TARGETS = new Set([
	"vscode",
	"github-copilot",
	"grok",
	"kimi",
]);

export type PluginsCommandProblem =
	| { kind: "missing" }
	| { kind: "broken"; detail: string }
	| { kind: "unrecognized" }
	| { kind: "outdated"; version: string };

export type UnusablePluginsCommand = {
	agent: AgentType;
	command: PluginsCommand;
	problem: PluginsCommandProblem;
};

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

const VERSION_TIMEOUT_MS = 10_000;

const versionParts = (version: string): number[] =>
	version.split(".").map((part) => Number.parseInt(part, 10));

/** Exported for tests. */
export const versionAtLeast = (version: string, minimum: string): boolean => {
	const have = versionParts(version);
	const need = versionParts(minimum);
	for (let i = 0; i < 3; i++) {
		const a = have[i] ?? 0;
		const b = need[i] ?? 0;
		if (a !== b) return a > b;
	}
	return true;
};

/** Exported for tests. */
export const pluginsCommandVersionProblem = (
	command: PluginsCommand,
	output: string,
): PluginsCommandProblem | undefined => {
	const label = `${command.versionPrefix} `;
	const at = output.indexOf(label);
	const version =
		at === -1
			? undefined
			: output.slice(at + label.length).match(/^\d+\.\d+\.\d+/)?.[0];
	if (version === undefined) {
		return { kind: "unrecognized" };
	}
	if (
		command.minVersion !== undefined &&
		!versionAtLeast(version, command.minVersion)
	) {
		return { kind: "outdated", version };
	}
	return undefined;
};

const firstLine = (text: string): string =>
	text
		.split("\n")
		.map((line) => line.trim())
		.find((line) => line.length > 0) ?? "";

/** The child sees the same PATH the command was resolved on, as under npx. */
const withPath = (env: NodeJS.ProcessEnv, path: string): NodeJS.ProcessEnv => {
	const key = Object.keys(env).find((name) => name.toUpperCase() === "PATH");
	return { ...env, [key ?? "PATH"]: path };
};

/**
 * Runs `<command> --version` the way the plugins CLI spawns the command (no shell, the npx
 * search PATH, its child env), so a command it could not run is caught before it runs.
 */
const probePluginsCommand = (
	command: PluginsCommand,
	options: { cwd: string; searchPath: string },
): PluginsCommandProblem | undefined => {
	const resolved = which.sync(command.name, {
		nothrow: true,
		path: options.searchPath,
	});
	if (resolved === null) {
		return { kind: "missing" };
	}
	const result = spawnSync(resolved, ["--version"], {
		cwd: options.cwd,
		env: withPath(pluginsChildEnv(), options.searchPath),
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		timeout: VERSION_TIMEOUT_MS,
		windowsHide: true,
	});
	if (result.error !== undefined) {
		const code =
			"code" in result.error && typeof result.error.code === "string"
				? result.error.code
				: undefined;
		return {
			kind: "broken",
			detail:
				code === "ETIMEDOUT"
					? `timed out after ${VERSION_TIMEOUT_MS / 1000} seconds`
					: (code ?? result.error.message),
		};
	}
	const output = `${result.stdout}\n${result.stderr}`;
	if (result.status !== 0) {
		const line = firstLine(result.stderr) || firstLine(result.stdout);
		return {
			kind: "broken",
			detail:
				line.length > 0
					? line.slice(0, 160).replace(/\.$/, "")
					: result.signal !== null
						? `killed by ${result.signal}`
						: `exit code ${result.status}`,
		};
	}
	return pluginsCommandVersionProblem(command, output);
};

const commandRows = (
	agents: readonly AgentType[],
	options: { cwd: string; path?: string },
	check: (
		command: PluginsCommand,
		searchPath: string,
	) => PluginsCommandProblem | undefined,
): UnusablePluginsCommand[] => {
	const searchPath = pluginsCommandSearchPath(
		options.cwd,
		options.path ?? process.env.PATH ?? "",
	);
	const rows: UnusablePluginsCommand[] = [];
	for (const agent of uniqueAgentIds(agents)) {
		const command = getPluginsTarget(agent)?.command;
		if (command === undefined) continue;
		const problem = check(command, searchPath);
		if (problem !== undefined) {
			rows.push({ agent, command, problem });
		}
	}
	return rows;
};

/**
 * Agents whose plugin command is not on the search PATH. Runs nothing, so it is safe for
 * agents that were only detected and may not be installed.
 */
export const missingPluginsCommands = (
	agents: readonly AgentType[],
	options: { cwd: string; path?: string },
): UnusablePluginsCommand[] =>
	commandRows(agents, options, (command, searchPath) =>
		which.sync(command.name, { nothrow: true, path: searchPath }) === null
			? { kind: "missing" }
			: undefined,
	);

/**
 * Agents whose plugin installs through a CLI that is missing, does not run, is not the
 * expected product, or is too old. Runs `<command> --version`, so pass only agents the
 * plugin is about to install into; file-based targets never spawn anything.
 */
export const unusablePluginsCommands = (
	agents: readonly AgentType[],
	options: { cwd: string; path?: string },
): UnusablePluginsCommand[] =>
	commandRows(agents, options, (command, searchPath) =>
		probePluginsCommand(command, { cwd: options.cwd, searchPath }),
	);

/** Completes `"<command>" …` in a warning or error. */
export const pluginsCommandProblemText = (
	row: UnusablePluginsCommand,
): string => {
	const { command, problem } = row;
	const product = command.product;
	switch (problem.kind) {
		case "missing":
			return "was not found on PATH";
		case "broken":
			return `did not run ("${command.name} --version" failed: ${problem.detail})`;
		case "unrecognized":
			return `is not ${product} ("${command.name} --version" printed no ${product} version)`;
		case "outdated":
			return `is ${product} ${problem.version}, older than the ${command.minVersion} its plugin needs`;
		default: {
			const _exhaustive: never = problem;
			return _exhaustive;
		}
	}
};

/** What to do about the problem, as an imperative clause. */
export const pluginsCommandFix = (row: UnusablePluginsCommand): string => {
	const { command, problem } = row;
	if (problem.kind === "missing") {
		return "Install it or add it to PATH";
	}
	return `Install or update ${command.product}`;
};

function getPluginsTarget(agent: string): PluginsTarget | undefined {
	if (Object.prototype.hasOwnProperty.call(PLUGINS_TARGET_BY_TYPE, agent)) {
		return PLUGINS_TARGET_BY_TYPE[agent as AgentType];
	}
	const id = tryResolveAddMcpAgentId(agent);
	if (!id) return undefined;
	return PLUGINS_TARGET_BY_TYPE[id];
}

export function getPluginsTargetName(agent: string): string | undefined {
	return getPluginsTarget(agent)?.target;
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
