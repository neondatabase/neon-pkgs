import { detectProjectAgents } from "add-mcp";

import {
	type AgentType,
	detectInstalledAgents,
	getSkillsAgentName,
	listMcpAgentIds,
	supportsSkills,
	uniqueAgentIds,
} from "../init/agents.js";

export type SkillsInstallScope = "global" | "project";

export const skillsInstallableAgents = (): AgentType[] =>
	listMcpAgentIds().filter((id) => supportsSkills(id));

export const detectSkillsAgents = async (options: {
	scope: SkillsInstallScope;
	cwd: string;
}): Promise<AgentType[]> => {
	const detected =
		options.scope === "project"
			? detectProjectAgents(options.cwd)
			: await detectInstalledAgents();
	return uniqueAgentIds(detected).filter((id) => supportsSkills(id));
};

export const mappedSkillsAgentNames = (
	agents: readonly AgentType[],
): string[] => {
	const names: string[] = [];
	const seen = new Set<string>();
	for (const agent of agents) {
		const name = getSkillsAgentName(agent);
		if (name === undefined || seen.has(name)) {
			continue;
		}
		seen.add(name);
		names.push(name);
	}
	if (names.length === 0) {
		throw new Error(
			`None of the selected agents can install skills. Supported agents: ${skillsInstallableAgents().join(", ")}`,
		);
	}
	return names;
};
