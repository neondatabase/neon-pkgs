import { detectProjectAgents } from "add-mcp";
import { log } from "../log.js";
import type { AgentType } from "../mcp/agents.js";
import { canPickAgentsInteractively } from "../utils/agent_picker.js";
import { getCliName } from "../utils/cli_name.js";
import { AUTH_CHILD, type InitRun } from "./child.js";
import { detectAgent } from "./detect_host.js";
import {
	type ChildForward,
	childArgv,
	chooseYesAgentTooling,
	collectYesAgents,
	type InitAgentSetup,
	type InitStep,
	initYesSupportedAgents,
	noDetectedAgentsMessage,
	planAgentSteps,
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
		}),
	);

export const runAgentTooling = async (
	options: AgentToolingOptions,
): Promise<void> => {
	const yes = options.yes;
	if (yes) {
		const agents = await yesAgentsFromOptions(options);
		const tooling = chooseYesAgentTooling(agents);
		if (tooling.setup === "skip") {
			throw yesMiss();
		}
		await runInitSteps(planYesAgentSteps(tooling), options);
		return;
	}
	const interactive =
		options.pickAgentSetup !== undefined || canPickAgentsInteractively();
	const agentSetup = await resolveInitAgentSetup({
		interactive,
		pick: options.pickAgentSetup ?? pickAgentSetupInteractively,
	});
	await runInitSteps(planAgentSteps({ yes, agentSetup }), options);
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
