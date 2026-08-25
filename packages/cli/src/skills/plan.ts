import { tryResolveAddMcpAgentId } from "../init/agents.js";
import type { AgentType } from "../mcp/agents.js";
import {
	agentChoicesFrom,
	type PickAgentsOptions,
	pickAgentsInteractively,
	resolveAgentSelection,
} from "../utils/agent_picker.js";
import {
	invocationsForSelection,
	resolveSkillId,
	type SkillEntry,
	type SkillsInvocation,
	uniqueSkillEntries,
	yesInstallInvocations,
} from "./catalog.js";
import {
	detectSkillsAgents,
	type SkillsInstallScope,
	skillsInstallableAgents,
} from "./targets.js";
import { pickSkillsInteractively } from "./wizard.js";

export type SkillsPlan = {
	scope: SkillsInstallScope;
	agents: AgentType[];
	skipped: AgentType[];
	invocations: SkillsInvocation[];
};

export type ResolveSkillsPlanOptions = {
	global: boolean;
	agents: readonly string[];
	skills: readonly string[];
	yes: boolean;
	cwd: string;
	interactive: boolean;
	pickAgents?: (options: PickAgentsOptions) => Promise<AgentType[]>;
	pickSkills?: () => Promise<SkillEntry[]>;
};

export const assertSkillsCanRun = (options: {
	yes: boolean;
	interactive: boolean;
	action: "install" | "update";
	hasSkills?: boolean;
}): void => {
	if (options.action === "update") {
		if (options.yes || options.interactive) {
			return;
		}
		throw new Error(
			"No interactive terminal. Pass -y to update installed skills.",
		);
	}
	if (options.yes || options.interactive || options.hasSkills === true) {
		return;
	}
	throw new Error(
		"No interactive terminal. Pass -y to install the default skills, or --skill <name>.",
	);
};

export async function resolveSkillsPlan(
	options: ResolveSkillsPlanOptions,
): Promise<SkillsPlan> {
	assertSkillsCanRun({
		yes: options.yes,
		interactive: options.interactive,
		action: "install",
		hasSkills: options.skills.length > 0,
	});
	const specified = uniqueSkillEntries(options.skills.map(resolveSkillId));
	const prompt = options.interactive && !options.yes;
	const scope: SkillsInstallScope = options.global ? "global" : "project";
	const available = skillsInstallableAgents();
	const detected = await detectSkillsAgents({
		scope,
		cwd: options.cwd,
	});
	const selected = await resolveAgentSelection({
		specified: options.agents,
		choices: agentChoicesFrom(available, detected),
		detected,
		message:
			"Which coding agents should get Neon agent skills? (space to toggle, enter to confirm)",
		nonInteractiveMessage:
			scope === "project"
				? `No coding agents detected in this project. Pass --agent <name>. Supported agents: ${available.join(", ")}`
				: `No coding agents detected. Pass --agent <name>. Supported agents: ${available.join(", ")}`,
		resolveSpecified: (raw) => {
			if (raw === "*") {
				throw new Error(
					"neon skills does not accept --agent *. Pass --agent <name> for each coding agent, or omit --agent to use detected agents.",
				);
			}
			const id = tryResolveAddMcpAgentId(raw);
			if (!id) {
				throw new Error(
					`Unknown agent: "${raw}". Supported agents: ${available.join(", ")}`,
				);
			}
			return id;
		},
		pick: prompt
			? (options.pickAgents ?? pickAgentsInteractively)
			: undefined,
		interactive: prompt,
	});
	const agents = selected.filter((id) => available.includes(id));
	const skipped = selected.filter((id) => !available.includes(id));
	if (agents.length === 0) {
		throw new Error(
			`None of the selected agents can install skills. Supported agents: ${available.join(", ")}`,
		);
	}

	const invocations =
		specified.length > 0
			? invocationsForSelection(specified)
			: options.yes
				? yesInstallInvocations()
				: invocationsForSelection(
						await (options.pickSkills ?? pickSkillsInteractively)(),
					);

	return { scope, agents, skipped, invocations };
}
