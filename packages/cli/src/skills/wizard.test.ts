import { describe, expect, test } from "vitest";

import { AGENT_SKILLS_SOURCE } from "./catalog.js";
import { skillsInstallSummary } from "./wizard.js";

describe("skillsInstallSummary", () => {
	test("names this directory, agents, and sources", () => {
		expect(
			skillsInstallSummary({
				scope: "project",
				agents: ["cursor"],
				invocations: [{ source: AGENT_SKILLS_SOURCE, skills: "*" }],
			}),
		).toBe(
			[
				"Config  this directory",
				"Agents  Cursor",
				"Skills  all from neondatabase/agent-skills",
			].join("\n"),
		);
	});

	test("names user-level and a partial skill list", () => {
		expect(
			skillsInstallSummary({
				scope: "global",
				agents: ["cursor", "claude-code"],
				invocations: [
					{ source: AGENT_SKILLS_SOURCE, skills: ["neon"] },
				],
			}),
		).toContain("user-level");
		expect(
			skillsInstallSummary({
				scope: "global",
				agents: ["cursor"],
				invocations: [
					{ source: AGENT_SKILLS_SOURCE, skills: ["neon"] },
				],
			}),
		).toContain("neon (neondatabase/agent-skills)");
	});
});
