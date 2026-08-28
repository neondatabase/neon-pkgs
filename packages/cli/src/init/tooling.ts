import { detectProjectAgents } from "add-mcp";
import { log } from "../log.js";
import type { AgentType } from "../mcp/agents.js";
import { canPickAgentsInteractively } from "../utils/agent_picker.js";
import { getCliName } from "../utils/cli_name.js";
import { AUTH_CHILD, type InitRun } from "./child.js";
import { detectAgent } from "./detect_host.js";
import {
	assertNamedAgentTooling,
	type ChildForward,
	childArgv,
	chooseYesAgentTooling,
	collectYesAgents,
	type InitAgentSetup,
	type InitStep,
	initYesSupportedAgents,
	noDetectedAgentsMessage,
	planAgentSteps,
	planToolingSteps,
	planYesAgentSteps,
	resolveInitAgentSetup,
} from "./plan.js";
import { pickAgentSetupInteractively } from "./wizard.js";

export type AgentDetectors = {
	detectProjectAgents?: (
		cwd: string,
	) => readonly AgentType[] | Promise<readonly AgentType[]>;
	detectAgent?: () => AgentType | null;
};

export type AgentToolingOptions = AgentDetectors & {
	cwd: string;
	yes: boolean;
	run: InitRun;
	forward: ChildForward;
	authEnv?: NodeJS.ProcessEnv;
	pickAgentSetup?: () => Promise<InitAgentSetup>;
	agents?: readonly AgentType[];
	hasProjectPlugins?: (cwd: string) => Promise<boolean>;
	agentSetup?: InitAgentSetup;
	command?: "init" | "bootstrap";
};

const defaultProjectAgents = (cwd: string): readonly AgentType[] =>
	detectProjectAgents(cwd);

export const runInitSteps = async (
	steps: readonly InitStep[],
	options: {
		cwd: string;
		run: InitRun;
		forward: ChildForward;
		authEnv?: NodeJS.ProcessEnv;
	},
): Promise<void> => {
	for (const step of steps) {
		log.info("Running `%s %s`", getCliName(), step.join(" "));
		const argv = childArgv(step, options.forward);
		const command = step[0];
		const ok = await options.run(
			argv,
			options.cwd,
			command !== undefined && AUTH_CHILD.has(command)
				? options.authEnv
				: undefined,
		);
		if (!ok) {
			throw new Error(`\`${getCliName()} ${step.join(" ")}\` failed.`);
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
		await runInitSteps(
			planToolingSteps(tooling, { yes, named: true }),
			options,
		);
		return tooling.setup;
	}
	if (options.agentSetup !== undefined) {
		await runInitSteps(
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
			await runInitSteps(
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
		await runInitSteps(planYesAgentSteps(tooling), options);
		return tooling.setup;
	}
	const interactive =
		options.pickAgentSetup !== undefined || canPickAgentsInteractively();
	const agentSetup = await resolveInitAgentSetup({
		interactive,
		pick: options.pickAgentSetup ?? pickAgentSetupInteractively,
	});
	await runInitSteps(planAgentSteps({ yes, agentSetup }), options);
	return agentSetup;
};

export type ScaffoldFollowUpOptions = AgentToolingOptions & {
	skipAgentSetup: boolean;
	shouldLink: boolean;
	linkYes: boolean;
};

export const runScaffoldFollowUp = async (
	options: ScaffoldFollowUpOptions,
): Promise<void> => {
	if (!options.skipAgentSetup) {
		await runAgentTooling(options);
	}
	if (options.shouldLink) {
		await runInitSteps(
			[options.linkYes ? ["link", "--yes"] : ["link"]],
			options,
		);
	}
};
