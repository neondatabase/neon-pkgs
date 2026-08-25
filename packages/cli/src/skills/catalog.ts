export const AGENT_SKILLS_SOURCE = "neondatabase/agent-skills";
export const PLATFORMS_SKILLS_SOURCE = "neondatabase/neon-for-agent-platforms";

export type SkillEntry = {
	source: string;
	skill: string;
	defaultSelected: boolean;
};

export const NEON_SKILL_CATALOG: readonly SkillEntry[] = [
	{
		source: AGENT_SKILLS_SOURCE,
		skill: "claimable-postgres",
		defaultSelected: true,
	},
	{ source: AGENT_SKILLS_SOURCE, skill: "neon", defaultSelected: true },
	{
		source: AGENT_SKILLS_SOURCE,
		skill: "neon-ai-gateway",
		defaultSelected: true,
	},
	{
		source: AGENT_SKILLS_SOURCE,
		skill: "neon-functions",
		defaultSelected: true,
	},
	{
		source: AGENT_SKILLS_SOURCE,
		skill: "neon-object-storage",
		defaultSelected: true,
	},
	{
		source: AGENT_SKILLS_SOURCE,
		skill: "neon-postgres",
		defaultSelected: true,
	},
	{
		source: AGENT_SKILLS_SOURCE,
		skill: "neon-postgres-branches",
		defaultSelected: true,
	},
	{
		source: AGENT_SKILLS_SOURCE,
		skill: "neon-postgres-egress-optimizer",
		defaultSelected: true,
	},
	{
		source: PLATFORMS_SKILLS_SOURCE,
		skill: "neon-postgres-agent-platforms",
		defaultSelected: false,
	},
];

export type SkillsInvocation = {
	source: string;
	skills: "*" | readonly string[];
};

export const yesInstallInvocations = (): SkillsInvocation[] => [
	{ source: AGENT_SKILLS_SOURCE, skills: "*" },
];

export const invocationsForSelection = (
	selected: readonly SkillEntry[],
): SkillsInvocation[] => {
	if (selected.length === 0) {
		throw new Error(
			"No skills selected. Pass -y to install every skill from neondatabase/agent-skills, or pick at least one skill.",
		);
	}
	const bySource = new Map<string, string[]>();
	for (const entry of selected) {
		const list = bySource.get(entry.source) ?? [];
		list.push(entry.skill);
		bySource.set(entry.source, list);
	}
	const invocations: SkillsInvocation[] = [];
	for (const [source, names] of bySource) {
		const catalog = NEON_SKILL_CATALOG.filter(
			(entry) => entry.source === source,
		);
		if (names.length === 0) {
			continue;
		}
		if (
			catalog.length > 0 &&
			catalog.every((entry) => names.includes(entry.skill))
		) {
			invocations.push({ source, skills: "*" });
			continue;
		}
		// Multiple --skill flags can create dirs without copying SKILL.md.
		for (const name of names) {
			invocations.push({ source, skills: [name] });
		}
	}
	return invocations;
};
