import { detectProjectAgents } from "add-mcp";
import {
	type McpInstallOutcome,
	mcpInstallError,
	reportMcpInstall,
	type SetupNeonMcpOptions,
} from "../commands/mcp.js";
import {
	type InstallPluginsOptions,
	installPlugins,
	type PluginsInstallOutcome,
	pluginsInstallError,
	reportPluginsInstall,
} from "../commands/plugins.js";
import {
	type InstallSkillsOptions,
	installSkills,
	reportSkillsInstall,
	type SkillsInstallOutcome,
	skillsInstallError,
} from "../commands/skills.js";
import { log } from "../log.js";
import type { AgentType } from "../mcp/agents.js";
import type { CommonProps } from "../types.js";
import {
	AgentSelectionSkipped,
	canPickAgentsInteractively,
} from "../utils/agent_picker.js";
import { getCliName } from "../utils/cli_name.js";
import { type InitAuthOptions, runAuthenticatedMcp } from "./auth.js";
import { raceSigint } from "./cancelled.js";
import { PROGRESS } from "./copy.js";
import { detectAgent } from "./detect_host.js";
import {
	assertNamedAgentTooling,
	chooseYesAgentTooling,
	collectYesAgents,
	type InitAgentSetup,
	type InitAgentSetupResult,
	initYesSupportedAgents,
	noDetectedAgentsMessage,
	planAgentSteps,
	planToolingSteps,
	planYesAgentSteps,
	resolveInitAgentSetup,
	type ToolingStep,
} from "./plan.js";
import { pickAgentSetupInteractively } from "./wizard.js";

export type AgentDetectors = {
	detectProjectAgents?: (
		cwd: string,
	) => readonly AgentType[] | Promise<readonly AgentType[]>;
	detectAgent?: () => AgentType | null;
};

/** One tooling step's install function, injectable so tests can assert on calls without a real npx/git/API round trip. */
export type ToolingOperations = {
	installPlugins: (
		options: Omit<InstallPluginsOptions, "cwd"> & { cwd: string },
	) => Promise<PluginsInstallOutcome>;
	installSkills: (
		options: Omit<InstallSkillsOptions, "cwd"> & { cwd: string },
	) => Promise<SkillsInstallOutcome>;
	installMcp: (
		options: Omit<
			SetupNeonMcpOptions,
			"cwd" | "apiClient" | "apiKey" | "contextFile"
		> & { cwd: string },
	) => Promise<McpInstallOutcome>;
};

export type AgentToolingOptions = AgentDetectors & {
	cwd: string;
	yes: boolean;
	output: CommonProps["output"];
	auth: InitAuthOptions;
	operations?: Partial<ToolingOperations>;
	pickAgentSetup?: () => Promise<InitAgentSetup>;
	agents?: readonly AgentType[];
	hasProjectPlugins?: (cwd: string) => Promise<boolean>;
	agentSetup?: InitAgentSetup;
	command?: "init" | "bootstrap";
	narrate?: "command" | "human";
};

const defaultProjectAgents = (cwd: string): readonly AgentType[] =>
	detectProjectAgents(cwd);

const TOOLING_STEP_LABELS: Record<ToolingStep["kind"], string> = {
	plugins: PROGRESS.plugins,
	skills: PROGRESS.skills,
	mcp: PROGRESS.mcp,
};

/** Reconstructs a display-only, `neon <command> <flags>` style string for a step. Never executed — only ever logged. */
const toolingStepCommandText = (step: ToolingStep): string => {
	const flags: string[] = [];
	switch (step.kind) {
		case "plugins": {
			const { options } = step;
			if (options.yes) flags.push("-y");
			if (options.global) flags.push("--global");
			for (const agent of options.agents ?? []) {
				flags.push("--agent", agent);
			}
			break;
		}
		case "skills": {
			const { options } = step;
			if (options.yes) flags.push("-y");
			if (options.global) flags.push("--global");
			for (const skill of options.skills ?? []) {
				flags.push("--skill", skill);
			}
			for (const agent of options.agents ?? []) {
				flags.push("--agent", agent);
			}
			break;
		}
		case "mcp": {
			const { options } = step;
			if (options.yes) flags.push("-y");
			if (options.oauth) flags.push("--oauth");
			if (options.project) flags.push("--project");
			if (options.projectId !== undefined) {
				flags.push("--project-id", options.projectId);
			}
			for (const agent of options.agent ?? []) {
				flags.push("--agent", agent);
			}
			break;
		}
		default: {
			const _exhaustive: never = step;
			return _exhaustive;
		}
	}
	return [step.kind, ...flags].join(" ");
};

/**
 * Runs plugins/skills/mcp installs in-process, in order, via {@link ToolingOperations}. This
 * replaces re-executing the `neon` binary as a child process (`neon plugins`, `neon skills`,
 * `neon mcp`) to reuse those commands — see `packages/cli/AGENTS.md`.
 */
export const runToolingSteps = async (
	steps: readonly ToolingStep[],
	options: {
		cwd: string;
		output: CommonProps["output"];
		auth: InitAuthOptions;
		operations?: Partial<ToolingOperations>;
		narrate?: "command" | "human";
		allowAgentSkip?: boolean;
	},
): Promise<ToolingStep["kind"][]> => {
	const ops: ToolingOperations = {
		installPlugins,
		installSkills,
		installMcp: (stepOptions) =>
			runAuthenticatedMcp({ ...stepOptions, ...options.auth }),
		...options.operations,
	};
	const reportProps = { output: options.output };
	const sharedOptions = {
		cwd: options.cwd,
		allowAgentSkip: options.allowAgentSkip,
	};
	const completed: ToolingStep["kind"][] = [];
	for (const step of steps) {
		const label =
			options.narrate === "human"
				? TOOLING_STEP_LABELS[step.kind]
				: undefined;
		if (label !== undefined) {
			process.stdout.write(`${label}\n`);
		} else {
			log.info(
				"Running `%s %s`",
				getCliName(),
				toolingStepCommandText(step),
			);
		}
		log.debug(
			"Running `%s %s`",
			getCliName(),
			toolingStepCommandText(step),
		);
		try {
			switch (step.kind) {
				case "plugins": {
					const outcome = await raceSigint(
						ops.installPlugins({
							...step.options,
							...sharedOptions,
						}),
					);
					reportPluginsInstall(reportProps, outcome);
					const error = pluginsInstallError(outcome);
					if (error) throw error;
					break;
				}
				case "skills": {
					const outcome = await raceSigint(
						ops.installSkills({
							...step.options,
							...sharedOptions,
						}),
					);
					reportSkillsInstall(reportProps, outcome);
					const error = skillsInstallError(outcome);
					if (error) throw error;
					break;
				}
				case "mcp": {
					const outcome = await raceSigint(
						ops.installMcp({ ...step.options, ...sharedOptions }),
					);
					reportMcpInstall(reportProps, outcome);
					const error = mcpInstallError(outcome);
					if (error) throw error;
					break;
				}
				default: {
					const _exhaustive: never = step;
					return _exhaustive;
				}
			}
			completed.push(step.kind);
		} catch (error) {
			if (!(error instanceof AgentSelectionSkipped)) throw error;
		}
	}
	return completed;
};

const agentSetupResult = (
	setup: InitAgentSetup,
	completed: readonly ToolingStep["kind"][],
): InitAgentSetupResult => {
	if (completed.length === 0) return "skip";
	if (setup === "skills-mcp" && completed.length === 1) {
		return completed[0] === "skills" ? "skills" : "mcp";
	}
	return setup;
};

const yesAgentsFromOptions = async (
	options: AgentToolingOptions,
): Promise<readonly AgentType[]> =>
	collectYesAgents({
		detected: () =>
			(options.detectProjectAgents ?? defaultProjectAgents)(options.cwd),
		detectAgent: options.detectAgent ?? detectAgent,
	});

const yesMiss = (): Error =>
	new Error(
		noDetectedAgentsMessage({
			scope: "project",
			supported: initYesSupportedAgents(),
			fix: "run-without-yes",
			nameAgent: true,
		}),
	);

export const runAgentTooling = async (
	options: AgentToolingOptions,
): Promise<InitAgentSetupResult> => {
	const yes = options.yes;
	const named = options.agents ?? [];
	const runSetup = async (
		setup: InitAgentSetup,
		steps: readonly ToolingStep[],
	): Promise<InitAgentSetupResult> =>
		agentSetupResult(
			setup,
			await runToolingSteps(steps, {
				...options,
				allowAgentSkip: !yes,
			}),
		);
	if (named.length > 0) {
		assertNamedAgentTooling(named, options.command ?? "init");
		const tooling = chooseYesAgentTooling(named);
		return runSetup(
			tooling.setup,
			planToolingSteps(tooling, { yes, named: true }),
		);
	}
	if (options.agentSetup !== undefined) {
		return runSetup(
			options.agentSetup,
			planAgentSteps({ yes, agentSetup: options.agentSetup }),
		);
	}
	if (yes) {
		if (options.hasProjectPlugins !== undefined) {
			const agentSetup: InitAgentSetup = (await options.hasProjectPlugins(
				options.cwd,
			))
				? "plugin"
				: "skills-mcp";
			return runSetup(
				agentSetup,
				planAgentSteps({ yes: true, agentSetup }),
			);
		}
		const agents = await yesAgentsFromOptions(options);
		const tooling = chooseYesAgentTooling(agents);
		if (tooling.setup === "skip") {
			throw yesMiss();
		}
		return runSetup(tooling.setup, planYesAgentSteps(tooling));
	}
	const interactive =
		options.pickAgentSetup !== undefined || canPickAgentsInteractively();
	const agentSetup = await resolveInitAgentSetup({
		interactive,
		pick: options.pickAgentSetup ?? pickAgentSetupInteractively,
	});
	return runSetup(agentSetup, planAgentSteps({ yes, agentSetup }));
};
