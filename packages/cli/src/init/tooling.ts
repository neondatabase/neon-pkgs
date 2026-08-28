import { log } from "../log.js";
import { detectInstallablePluginsAgents } from "../plugins/targets.js";
import { canPickAgentsInteractively } from "../utils/agent_picker.js";
import { getCliName } from "../utils/cli_name.js";
import { AUTH_CHILD, type InitRun } from "./child.js";
import {
	type ChildForward,
	childArgv,
	type InitAgentSetup,
	type InitStep,
	planAgentSteps,
	resolveInitAgentSetup,
} from "./plan.js";
import { pickAgentSetupInteractively } from "./wizard.js";

export type AgentToolingOptions = {
	cwd: string;
	yes: boolean;
	run: InitRun;
	forward: ChildForward;
	authEnv?: NodeJS.ProcessEnv;
	pickAgentSetup?: () => Promise<InitAgentSetup>;
	hasProjectPlugins?: (cwd: string) => Promise<boolean>;
	agentSetup?: InitAgentSetup;
};

const defaultHasProjectPlugins = async (cwd: string): Promise<boolean> => {
	const detected = await detectInstallablePluginsAgents({
		scope: "project",
		cwd,
	});
	return detected.length > 0;
};

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

export const runAgentTooling = async (
	options: AgentToolingOptions,
): Promise<InitAgentSetup> => {
	const yes = options.yes;
	const hasProjectPlugins = yes
		? await (options.hasProjectPlugins ?? defaultHasProjectPlugins)(
				options.cwd,
			)
		: false;
	const interactive =
		!yes &&
		(options.pickAgentSetup !== undefined || canPickAgentsInteractively());
	const agentSetup =
		options.agentSetup ??
		(await resolveInitAgentSetup({
			yes,
			interactive,
			hasProjectPlugins,
			pick: options.pickAgentSetup ?? pickAgentSetupInteractively,
		}));
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
