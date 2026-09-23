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
import { canPickAgentsInteractively } from "../utils/agent_picker.js";
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
	},
): Promise<void> => {
	const ops: ToolingOperations = {
		installPlugins,
		installSkills,
		installMcp: (stepOptions) =>
			runAuthenticatedMcp({ ...stepOptions, ...options.auth }),
		...options.operations,
	};
	const reportProps = { output: options.output };
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
		switch (step.kind) {
			case "plugins": {
				const outcome = await raceSigint(
					ops.installPlugins({ ...step.options, cwd: options.cwd }),
				);
				reportPluginsInstall(reportProps, outcome);
				const error = pluginsInstallError(outcome);
				if (error) throw error;
				break;
			}
			case "skills": {
				const outcome = await raceSigint(
					ops.installSkills({ ...step.options, cwd: options.cwd }),
				);
				reportSkillsInstall(reportProps, outcome);
				const error = skillsInstallError(outcome);
				if (error) throw error;
				break;
			}
			case "mcp": {
				const outcome = await raceSigint(
					ops.installMcp({ ...step.options, cwd: options.cwd }),
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
	}
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
): Promise<InitAgentSetup> => {
	const yes = options.yes;
	const named = options.agents ?? [];
	if (named.length > 0) {
		assertNamedAgentTooling(named, options.command ?? "init");
		const tooling = chooseYesAgentTooling(named);
		await runToolingSteps(
			planToolingSteps(tooling, { yes, named: true }),
			options,
		);
		return tooling.setup;
	}
	if (options.agentSetup !== undefined) {
		await runToolingSteps(
			planAgentSteps({ yes, agentSetup: options.agentSetup }),
			options,
		);
		return options.agentSetup;
	}
	if (yes) {
		if (options.hasProjectPlugins !== undefined) {
			const agentSetup: InitAgentSetup = (await options.hasProjectPlugins(
				options.cwd,
			))
				? "plugin"
				: "skills-mcp";
			await runToolingSteps(
				planAgentSteps({ yes: true, agentSetup }),
				options,
			);
			return agentSetup;
		}
		const agents = await yesAgentsFromOptions(options);
		const tooling = chooseYesAgentTooling(agents);
		if (tooling.setup === "skip") {
			throw yesMiss();
		}
		await runToolingSteps(planYesAgentSteps(tooling), options);
		return tooling.setup;
	}
	const interactive =
		options.pickAgentSetup !== undefined || canPickAgentsInteractively();
	const agentSetup = await resolveInitAgentSetup({
		interactive,
		pick: options.pickAgentSetup ?? pickAgentSetupInteractively,
	});
	await runToolingSteps(planAgentSteps({ yes, agentSetup }), options);
	return agentSetup;
};
