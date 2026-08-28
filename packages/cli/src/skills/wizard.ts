import prompts from "prompts";

import { getAgentDisplayName } from "../init/agents.js";
import type { AgentType } from "../mcp/agents.js";
import { canPickAgentsInteractively } from "../utils/agent_picker.js";
import {
	NEON_SKILL_CATALOG,
	type SkillEntry,
	type SkillsInvocation,
} from "./catalog.js";
import type { SkillsInstallScope } from "./targets.js";

const restoreCursorOnAbort = (state: { aborted: boolean }) => {
	if (state.aborted) {
		process.stdout.write("\x1B[?25h");
		process.stdout.write("\n");
		process.exit(1);
	}
};

export const pickSkillsInteractively = async (): Promise<SkillEntry[]> => {
	if (!canPickAgentsInteractively()) {
		throw new Error(
			"No interactive terminal. Pass -y to install the default skills into detected agents.",
		);
	}
	const { skills } = await prompts({
		onState: restoreCursorOnAbort,
		type: "multiselect",
		name: "skills",
		message:
			"Which Neon agent skills should be installed? (space to toggle, enter to confirm)",
		instructions: false,
		min: 1,
		choices: NEON_SKILL_CATALOG.map((entry) => ({
			value: entry,
			title: entry.skill,
			selected: entry.defaultSelected,
		})),
	});
	if (!Array.isArray(skills) || skills.length === 0) {
		throw new Error(
			"No skills selected. Pass -y to install the default skills, or --skill <name>.",
		);
	}
	return skills.filter(isSkillEntry);
};

const isSkillEntry = (value: unknown): value is SkillEntry => {
	if (typeof value !== "object" || value === null) {
		return false;
	}
	if (!("source" in value) || !("skill" in value)) {
		return false;
	}
	return (
		typeof value.source === "string" &&
		typeof value.skill === "string" &&
		value.source.length > 0 &&
		value.skill.length > 0
	);
};

export const skillsInstallSummary = (options: {
	scope: SkillsInstallScope;
	agents: readonly AgentType[];
	invocations: readonly SkillsInvocation[];
}): string => {
	const skills = options.invocations
		.flatMap((invocation) => invocation.skills)
		.join(", ");
	const rows: [string, string][] = [
		[
			"Config",
			options.scope === "project" ? "this directory" : "user-level",
		],
		["Agents", options.agents.map(getAgentDisplayName).join(", ")],
		["Skills", skills],
	];
	const labelWidth = Math.max(...rows.map(([label]) => label.length));
	return rows
		.map(([label, value]) => `${label.padEnd(labelWidth)}  ${value}`)
		.join("\n");
};

export const confirmSkillsInstall = async (options: {
	scope: SkillsInstallScope;
	agents: readonly AgentType[];
	invocations: readonly SkillsInvocation[];
}): Promise<boolean> => {
	if (!canPickAgentsInteractively()) {
		return true;
	}
	process.stdout.write(`\n${skillsInstallSummary(options)}\n\n`);
	const { ok } = await prompts({
		onState: restoreCursorOnAbort,
		type: "confirm",
		name: "ok",
		message: "Write Neon agent skills into these agents?",
		initial: true,
	});
	return ok === true;
};

export const confirmSkillsUpdate = async (options: {
	scope: SkillsInstallScope;
}): Promise<boolean> => {
	if (!canPickAgentsInteractively()) {
		return true;
	}
	const config =
		options.scope === "project" ? "this directory" : "user-level";
	process.stdout.write(`\nConfig  ${config}\n\n`);
	const { ok } = await prompts({
		onState: restoreCursorOnAbort,
		type: "confirm",
		name: "ok",
		message: "Update installed skills to the latest versions?",
		initial: true,
	});
	return ok === true;
};
