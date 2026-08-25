import { describe, expect, test } from "vitest";

import { AGENT_SKILLS_SOURCE, PLATFORMS_SKILLS_SOURCE } from "./catalog.js";
import { skillsInstallSummary } from "./wizard.js";

describe("skillsInstallSummary", () => {
	test("names this directory, agents, and skill ids", () => {
		expect(
			skillsInstallSummary({
				scope: "project",
				agents: ["cursor"],
				invocations: [
					{
						source: AGENT_SKILLS_SOURCE,
						skills: ["neon", "neon-ai-gateway"],
					},
				],
			}),
		).toBe(
			[
				"Config  this directory",
				"Agents  Cursor",
				"Skills  neon, neon-ai-gateway",
			].join("\n"),
		);
	});

	test("names user-level skills without repos", () => {
		const text = skillsInstallSummary({
			scope: "global",
			agents: ["cursor", "claude-code"],
			invocations: [
				{ source: AGENT_SKILLS_SOURCE, skills: ["neon"] },
				{
					source: PLATFORMS_SKILLS_SOURCE,
					skills: ["neon-postgres-agent-platforms"],
				},
			],
		});
		expect(text).toContain("user-level");
		expect(text).toContain("neon, neon-postgres-agent-platforms");
		expect(text).not.toContain("neondatabase/");
	});
});
