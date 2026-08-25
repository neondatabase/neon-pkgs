import { describe, expect, test } from "vitest";

import {
	AGENT_SKILLS_SOURCE,
	invocationsForSelection,
	NEON_SKILL_CATALOG,
	PLATFORMS_SKILLS_SOURCE,
	yesInstallInvocations,
} from "./catalog.js";

const entry = (skill: string) => {
	const found = NEON_SKILL_CATALOG.find((item) => item.skill === skill);
	if (!found) {
		throw new Error(`missing catalog skill: ${skill}`);
	}
	return found;
};

describe("yesInstallInvocations", () => {
	test("installs every skill from agent-skills only", () => {
		expect(yesInstallInvocations()).toEqual([
			{ source: AGENT_SKILLS_SOURCE, skills: "*" },
		]);
	});
});

describe("invocationsForSelection", () => {
	test("rejects an empty selection", () => {
		expect(() => invocationsForSelection([])).toThrow(/No skills selected/);
	});

	test("uses --skill * when every catalog skill for a source is selected", () => {
		const agentSkills = NEON_SKILL_CATALOG.filter(
			(item) => item.source === AGENT_SKILLS_SOURCE,
		);
		expect(invocationsForSelection(agentSkills)).toEqual([
			{ source: AGENT_SKILLS_SOURCE, skills: "*" },
		]);
	});

	test("emits one skill per invocation for a partial source", () => {
		expect(
			invocationsForSelection([entry("neon"), entry("neon-postgres")]),
		).toEqual([
			{ source: AGENT_SKILLS_SOURCE, skills: ["neon"] },
			{ source: AGENT_SKILLS_SOURCE, skills: ["neon-postgres"] },
		]);
	});

	test("keeps platforms as its own source", () => {
		expect(
			invocationsForSelection([
				entry("neon"),
				entry("neon-postgres-agent-platforms"),
			]),
		).toEqual([
			{ source: AGENT_SKILLS_SOURCE, skills: ["neon"] },
			{
				source: PLATFORMS_SKILLS_SOURCE,
				skills: "*",
			},
		]);
	});
});
