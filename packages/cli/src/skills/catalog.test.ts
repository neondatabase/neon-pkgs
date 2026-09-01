import { describe, expect, test } from "vitest";

import {
	AGENT_SKILLS_SOURCE,
	defaultSkillEntries,
	invocationsForSelection,
	listSkillIds,
	NEON_SKILL_CATALOG,
	PLATFORMS_SKILLS_SOURCE,
	resolveSkillId,
	skillsHelpValues,
	skillsYesHelp,
	yesInstallInvocations,
} from "./catalog.js";

const entry = (skill: string) => resolveSkillId(skill);

describe("NEON_SKILL_CATALOG", () => {
	test("skill ids are unique", () => {
		const ids = listSkillIds();
		expect(new Set(ids).size).toBe(ids.length);
	});

	test("help values group skills by source", () => {
		const text = skillsHelpValues();
		expect(text.match(new RegExp(AGENT_SKILLS_SOURCE, "g"))).toHaveLength(
			1,
		);
		expect(
			text.match(new RegExp(PLATFORMS_SKILLS_SOURCE, "g")),
		).toHaveLength(1);
		for (const row of NEON_SKILL_CATALOG) {
			expect(text).toContain(row.skill);
		}
	});

	test("yes help names the skills -y leaves out", () => {
		expect(skillsYesHelp()).toBe(
			"neon skills -y installs every listed skill except neon-postgres-agent-platforms",
		);
	});

	test("does not offer the deleted claimable-postgres skill", () => {
		expect(listSkillIds()).not.toContain("claimable-postgres");
		expect(() => resolveSkillId("claimable-postgres")).toThrow(
			/Unknown skill: "claimable-postgres"/,
		);
	});
});

describe("resolveSkillId", () => {
	test("rejects * and unknown names", () => {
		expect(() => resolveSkillId("*")).toThrow(/does not accept --skill \*/);
		expect(() => resolveSkillId("eve")).toThrow(/Unknown skill: "eve"/);
	});

	test("maps platforms to its own repo", () => {
		expect(resolveSkillId("neon-postgres-agent-platforms").source).toBe(
			PLATFORMS_SKILLS_SOURCE,
		);
		expect(resolveSkillId("neon").source).toBe(AGENT_SKILLS_SOURCE);
	});
});

describe("yesInstallInvocations", () => {
	test("installs every default skill from agent-skills only", () => {
		expect(yesInstallInvocations()).toEqual([
			{
				source: AGENT_SKILLS_SOURCE,
				skills: defaultSkillEntries().map((item) => item.skill),
			},
		]);
		expect(
			defaultSkillEntries().some((item) => !item.defaultSelected),
		).toBe(false);
		expect(
			NEON_SKILL_CATALOG.filter((item) => !item.defaultSelected).map(
				(item) => item.skill,
			),
		).toEqual(["neon-postgres-agent-platforms"]);
	});
});

describe("invocationsForSelection", () => {
	test("rejects an empty selection", () => {
		expect(() => invocationsForSelection([])).toThrow(/No skills selected/);
	});

	test("groups one source into one add with every selected -s", () => {
		expect(
			invocationsForSelection([entry("neon"), entry("neon-postgres")]),
		).toEqual([
			{
				source: AGENT_SKILLS_SOURCE,
				skills: ["neon", "neon-postgres"],
			},
		]);
	});

	test("dedupes repeated skill ids", () => {
		expect(invocationsForSelection([entry("neon"), entry("neon")])).toEqual(
			[{ source: AGENT_SKILLS_SOURCE, skills: ["neon"] }],
		);
	});

	test("routes platforms to its own source", () => {
		expect(
			invocationsForSelection([
				entry("neon"),
				entry("neon-postgres-agent-platforms"),
			]),
		).toEqual([
			{ source: AGENT_SKILLS_SOURCE, skills: ["neon"] },
			{
				source: PLATFORMS_SKILLS_SOURCE,
				skills: ["neon-postgres-agent-platforms"],
			},
		]);
	});
});
