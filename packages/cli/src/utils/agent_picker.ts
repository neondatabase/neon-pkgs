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

export class AgentSelectionSkipped extends Error {}

export type PickAgentsOptions = {
	message: string;
	choices: readonly AgentChoice[];
	selected?: readonly AgentType[];
	/** An empty selection is returned only after confirming this message. */
	skipMessage?: string;
	onCancel?: () => never;
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

const restoreCursorOnAbort = (state: { aborted: boolean }) => {
	if (state.aborted) {
		// prompts leaves the cursor hidden when selection is aborted.
		process.stdout.write("\x1B[?25h");
		process.stdout.write("\n");
	}
};

export const pickAgentsInteractively = async (
	options: PickAgentsOptions,
): Promise<AgentType[]> => {
	if (!canPickAgentsInteractively()) {
		throw new Error(
			"No interactive terminal. Pass -y, or run this command in a terminal to pick agents.",
		);
	}
	if (options.choices.length === 0) {
		throw new Error("No coding agents are available to pick.");
	}

	const cancel = options.onCancel ?? (() => process.exit(1));
	const selected = new Set(options.selected ?? []);
	const question = {
		onState: restoreCursorOnAbort,
		type: "multiselect" as const,
		name: "agents",
		message: options.message,
		instructions: false,
		min: options.skipMessage ? 0 : 1,
		choices: options.choices.map((choice) => ({
			value: choice.id,
			title: choice.title,
			description: choice.description,
			selected: selected.has(choice.id),
		})),
	};
	while (true) {
		const { agents } = await prompts(question);
		if (!Array.isArray(agents)) return cancel();
		const picked: AgentType[] = [];
		for (const value of agents) {
			const id = agentIdInChoices(value, options.choices);
			if (id === undefined) {
				throw new Error(`Unknown agent: "${String(value)}".`);
			}
			picked.push(id);
		}
		if (picked.length > 0 || !options.skipMessage) {
			return uniqueAgentIds(picked);
		}
		const { skip } = await prompts({
			onState: restoreCursorOnAbort,
			type: "confirm",
			name: "skip",
			message: options.skipMessage,
			initial: true,
		});
		if (typeof skip !== "boolean") return cancel();
		if (skip) return [];
	}
};

export const skippableAgentPicker = (
	allowed: boolean | undefined,
	message: string,
): ((options: PickAgentsOptions) => Promise<AgentType[]>) | undefined =>
	allowed
		? async (options) => {
				const selected = await pickAgentsInteractively({
					...options,
					skipMessage: message,
				});
				if (selected.length === 0) throw new AgentSelectionSkipped();
				return selected;
			}
		: undefined;

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
				"No agents selected. Pick at least one agent, or pass -y to use detected agents.",
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
