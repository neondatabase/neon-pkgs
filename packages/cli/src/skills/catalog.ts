import { helpCsv } from "../utils/help_text.js";

export const AGENT_SKILLS_SOURCE = "neondatabase/agent-skills";
export const PLATFORMS_SKILLS_SOURCE = "neondatabase/neon-for-agent-platforms";

export type SkillEntry = {
	skill: string;
	source: string;
	defaultSelected: boolean;
};

export const NEON_SKILL_CATALOG: readonly SkillEntry[] = [
	{ skill: "neon", source: AGENT_SKILLS_SOURCE, defaultSelected: true },
	{
		skill: "neon-ai-gateway",
		source: AGENT_SKILLS_SOURCE,
		defaultSelected: true,
	},
	{
		skill: "neon-functions",
		source: AGENT_SKILLS_SOURCE,
		defaultSelected: true,
	},
	{
		skill: "neon-object-storage",
		source: AGENT_SKILLS_SOURCE,
		defaultSelected: true,
	},
	{
		skill: "neon-postgres",
		source: AGENT_SKILLS_SOURCE,
		defaultSelected: true,
	},
	{
		skill: "neon-postgres-branches",
		source: AGENT_SKILLS_SOURCE,
		defaultSelected: true,
	},
	{
		skill: "neon-postgres-egress-optimizer",
		source: AGENT_SKILLS_SOURCE,
		defaultSelected: true,
	},
	{
		skill: "neon-postgres-agent-platforms",
		source: PLATFORMS_SKILLS_SOURCE,
		defaultSelected: false,
	},
];

const catalogBySkill = (): Map<string, SkillEntry> => {
	const map = new Map<string, SkillEntry>();
	for (const entry of NEON_SKILL_CATALOG) {
		if (map.has(entry.skill)) {
			throw new Error(`Duplicate catalog skill: ${entry.skill}`);
		}
		map.set(entry.skill, entry);
	}
	return map;
};

const CATALOG_BY_SKILL = catalogBySkill();

export const listSkillIds = (): string[] =>
	NEON_SKILL_CATALOG.map((entry) => entry.skill);

export const defaultSkillEntries = (): SkillEntry[] =>
	NEON_SKILL_CATALOG.filter((entry) => entry.defaultSelected);

export function resolveSkillId(raw: string): SkillEntry {
	if (raw === "*") {
		throw new Error(
			"neon skills does not accept --skill *. Pass --skill <name> for each skill, or omit --skill to install the default skills with -y.",
		);
	}
	const entry = CATALOG_BY_SKILL.get(raw);
	if (entry === undefined) {
		throw new Error(
			`Unknown skill: "${raw}". Supported skills: ${listSkillIds().join(", ")}`,
		);
	}
	return entry;
}

export function uniqueSkillEntries(
	entries: readonly SkillEntry[],
): SkillEntry[] {
	const seen = new Set<string>();
	const out: SkillEntry[] = [];
	for (const entry of entries) {
		if (seen.has(entry.skill)) {
			continue;
		}
		seen.add(entry.skill);
		out.push(entry);
	}
	return out;
}

export type SkillsInvocation = {
	source: string;
	skills: readonly string[];
};

export const invocationsForSelection = (
	selected: readonly SkillEntry[],
): SkillsInvocation[] => {
	const unique = uniqueSkillEntries(selected);
	if (unique.length === 0) {
		throw new Error(
			"No skills selected. Pass -y to install the default skills, or --skill <name>.",
		);
	}
	const bySource = new Map<string, string[]>();
	const sourceOrder: string[] = [];
	for (const entry of unique) {
		const list = bySource.get(entry.source);
		if (list === undefined) {
			bySource.set(entry.source, [entry.skill]);
			sourceOrder.push(entry.source);
		} else {
			list.push(entry.skill);
		}
	}
	return sourceOrder.map((source) => {
		const skills = bySource.get(source);
		if (skills === undefined || skills.length === 0) {
			throw new Error("skills add needs at least one --skill.");
		}
		return { source, skills };
	});
};

export const yesInstallInvocations = (): SkillsInvocation[] =>
	invocationsForSelection(defaultSkillEntries());

export const skillsHelpValues = (): string =>
	invocationsForSelection(NEON_SKILL_CATALOG)
		.map((group) => helpCsv(`  ${group.source}`, group.skills))
		.join("\n");

export const skillsYesHelp = (): string => {
	const omitted = NEON_SKILL_CATALOG.filter(
		(entry) => !entry.defaultSelected,
	).map((entry) => entry.skill);
	if (omitted.length === 0) {
		return "neon skills -y installs every listed skill";
	}
	return `neon skills -y installs every listed skill except ${omitted.join(", ")}`;
};
