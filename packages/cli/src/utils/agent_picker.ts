import prompts from "prompts";

import { isCi } from "../env.js";
import {
	type AgentType,
	getAgentDisplayName,
	resolveAddMcpAgentId,
	uniqueAgentIds,
} from "../mcp/agents.js";

export type AgentChoice = {
	id: AgentType;
	title: string;
	description?: string;
};

export type PickAgentsOptions = {
	message: string;
	choices: readonly AgentChoice[];
	selected?: readonly AgentType[];
};

export type ResolveAgentSelectionOptions = {
	specified: readonly string[];
	choices: readonly AgentChoice[];
	detected: readonly AgentType[];
	message: string;
	nonInteractiveMessage: string;
	resolveSpecified?: (raw: string) => AgentType;
	pick?: (options: PickAgentsOptions) => Promise<AgentType[]>;
	interactive?: boolean;
};

export const canPickAgentsInteractively = (): boolean =>
	!isCi() && Boolean(process.stdout.isTTY) && Boolean(process.stdin.isTTY);

export const pickAgentsInteractively = async (
	options: PickAgentsOptions,
): Promise<AgentType[]> => {
	if (!canPickAgentsInteractively()) {
		throw new Error(
			"No interactive terminal. Pass --agent <name>, or run this command in a terminal to pick agents.",
		);
	}
	if (options.choices.length === 0) {
		throw new Error("No coding agents are available to pick.");
	}

	const selected = new Set(options.selected ?? []);
	const { agents } = await prompts({
		onState: (state: { aborted: boolean }) => {
			if (state.aborted) {
				// prompts leaves the cursor hidden when selection is aborted.
				process.stdout.write("\x1B[?25h");
				process.stdout.write("\n");
				process.exit(1);
			}
		},
		type: "multiselect",
		name: "agents",
		message: options.message,
		instructions: false,
		min: 1,
		choices: options.choices.map((choice) => ({
			value: choice.id,
			title: choice.title,
			description: choice.description,
			selected: selected.has(choice.id),
		})),
	});

	if (!Array.isArray(agents)) {
		throw new Error("Aborted: no agents selected.");
	}

	const picked: AgentType[] = [];
	for (const value of agents) {
		const id = agentIdInChoices(value, options.choices);
		if (id === undefined) {
			throw new Error(`Unknown agent: "${String(value)}".`);
		}
		picked.push(id);
	}
	return uniqueAgentIds(picked);
};

export const resolveAgentSelection = async (
	options: ResolveAgentSelectionOptions,
): Promise<AgentType[]> => {
	if (options.specified.length > 0) {
		const resolve = options.resolveSpecified ?? resolveAddMcpAgentId;
		return uniqueAgentIds(options.specified.map(resolve));
	}

	const pick =
		options.pick ??
		((options.interactive ?? canPickAgentsInteractively())
			? pickAgentsInteractively
			: undefined);
	if (pick) {
		const selected = await pick({
			message: options.message,
			choices: options.choices,
			selected: options.detected.filter((id) =>
				options.choices.some((choice) => choice.id === id),
			),
		});
		if (selected.length === 0) {
			throw new Error(
				"No agents selected. Pass --agent <name>, or pick at least one agent.",
			);
		}
		return uniqueAgentIds(selected);
	}

	if (options.detected.length > 0) {
		return uniqueAgentIds(options.detected);
	}

	throw new Error(options.nonInteractiveMessage);
};

export const agentChoicesFrom = (
	available: readonly AgentType[],
	detected: readonly AgentType[],
): AgentChoice[] => {
	const detectedSet = new Set(detected);
	const ordered = [
		...available.filter((id) => detectedSet.has(id)),
		...available.filter((id) => !detectedSet.has(id)),
	];
	return ordered.map((id) => ({
		id,
		title: getAgentDisplayName(id),
		...(detectedSet.has(id) ? { description: "detected" } : {}),
	}));
};

const agentIdInChoices = (
	value: unknown,
	choices: readonly AgentChoice[],
): AgentType | undefined => {
	if (typeof value !== "string") {
		return undefined;
	}
	for (const choice of choices) {
		if (choice.id === value) {
			return choice.id;
		}
	}
	return undefined;
};
