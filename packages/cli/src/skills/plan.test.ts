import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { AGENT_SKILLS_SOURCE, NEON_SKILL_CATALOG } from "./catalog.js";
import {
	assertSkillsCanRun,
	type ResolveSkillsPlanOptions,
	resolveSkillsPlan,
} from "./plan.js";

const dirs: string[] = [];

afterEach(() => {
	for (const dir of dirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function tmpDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "neon-skills-plan-"));
	dirs.push(dir);
	return dir;
}

function planOptions(
	cwd: string,
	overrides: Partial<ResolveSkillsPlanOptions> = {},
): ResolveSkillsPlanOptions {
	return {
		global: false,
		agents: ["cursor"],
		yes: false,
		cwd,
		interactive: true,
		pickSkills: async () => {
			throw new Error("skill prompt");
		},
		pickAgents: async () => {
			throw new Error("agent prompt");
		},
		...overrides,
	};
}

describe("assertSkillsCanRun", () => {
	test("fails non-TTY without -y, including when agents are named", () => {
		expect(() =>
			assertSkillsCanRun({
				yes: false,
				interactive: false,
				action: "install",
			}),
		).toThrow(/Pass -y to install every skill/);
		expect(() =>
			assertSkillsCanRun({
				yes: false,
				interactive: false,
				action: "update",
			}),
		).toThrow(/Pass -y to update installed skills/);
	});

	test("allows -y or a TTY", () => {
		expect(() =>
			assertSkillsCanRun({
				yes: true,
				interactive: false,
				action: "install",
			}),
		).not.toThrow();
		expect(() =>
			assertSkillsCanRun({
				yes: false,
				interactive: true,
				action: "install",
			}),
		).not.toThrow();
	});
});

describe("resolveSkillsPlan", () => {
	test("-y is this directory, specified agents, all agent-skills, and calls no prompts", async () => {
		const cwd = tmpDir();
		const plan = await resolveSkillsPlan(
			planOptions(cwd, {
				yes: true,
				interactive: false,
			}),
		);
		expect(plan).toEqual({
			scope: "project",
			agents: ["cursor"],
			skipped: [],
			invocations: [{ source: AGENT_SKILLS_SOURCE, skills: "*" }],
		});
	});

	test("non-TTY without -y fails even when --agent is set", async () => {
		const cwd = tmpDir();
		await expect(
			resolveSkillsPlan(
				planOptions(cwd, {
					yes: false,
					interactive: false,
					agents: ["cursor"],
				}),
			),
		).rejects.toThrow(/Pass -y to install every skill/);
	});

	test("--global is user-level", async () => {
		const cwd = tmpDir();
		const plan = await resolveSkillsPlan(
			planOptions(cwd, { yes: true, interactive: false, global: true }),
		);
		expect(plan.scope).toBe("global");
	});

	test("--agent skips the agent picker and still asks for skills", async () => {
		const cwd = tmpDir();
		const neon = NEON_SKILL_CATALOG.find((item) => item.skill === "neon");
		if (!neon) {
			throw new Error("missing neon skill");
		}
		const plan = await resolveSkillsPlan(
			planOptions(cwd, {
				agents: ["claude"],
				pickSkills: async () => [neon],
			}),
		);
		expect(plan.agents).toEqual(["claude-code"]);
		expect(plan.invocations).toEqual([
			{ source: AGENT_SKILLS_SOURCE, skills: ["neon"] },
		]);
	});

	test("interactive asks agents then skills", async () => {
		const cwd = tmpDir();
		mkdirSync(join(cwd, ".cursor"));
		const neon = NEON_SKILL_CATALOG.find((item) => item.skill === "neon");
		if (!neon) {
			throw new Error("missing neon skill");
		}
		const calls: string[] = [];
		const plan = await resolveSkillsPlan(
			planOptions(cwd, {
				agents: [],
				pickAgents: async (options) => {
					calls.push("agents");
					expect(options.selected).toEqual(["cursor"]);
					return ["cursor"];
				},
				pickSkills: async () => {
					calls.push("skills");
					return [neon];
				},
			}),
		);
		expect(calls).toEqual(["agents", "skills"]);
		expect(plan.scope).toBe("project");
		expect(plan.agents).toEqual(["cursor"]);
	});

	test("rejects skills-CLI-only agent names", async () => {
		const cwd = tmpDir();
		await expect(
			resolveSkillsPlan(
				planOptions(cwd, {
					yes: true,
					interactive: false,
					agents: ["eve"],
				}),
			),
		).rejects.toThrow(/Unknown agent: "eve"/);
		await expect(
			resolveSkillsPlan(
				planOptions(cwd, {
					yes: true,
					interactive: false,
					agents: ["cursor-cli"],
				}),
			),
		).rejects.toThrow(/Unknown agent: "cursor-cli"/);
	});

	test("rejects --agent *", async () => {
		const cwd = tmpDir();
		await expect(
			resolveSkillsPlan(
				planOptions(cwd, {
					yes: true,
					interactive: false,
					agents: ["*"],
				}),
			),
		).rejects.toThrow(/does not accept --agent \*/);
	});

	test("skips MCP agents that cannot install skills", async () => {
		const cwd = tmpDir();
		const plan = await resolveSkillsPlan(
			planOptions(cwd, {
				yes: true,
				interactive: false,
				agents: ["cursor", "mcporter"],
			}),
		);
		expect(plan.agents).toEqual(["cursor"]);
		expect(plan.skipped).toEqual(["mcporter"]);
	});

	test("fails when every selected agent lacks a skills mapping", async () => {
		const cwd = tmpDir();
		await expect(
			resolveSkillsPlan(
				planOptions(cwd, {
					yes: true,
					interactive: false,
					agents: ["mcporter"],
				}),
			),
		).rejects.toThrow(/None of the selected agents can install skills/);
	});

	test("non-interactive project with no folder agents fails", async () => {
		const cwd = tmpDir();
		await expect(
			resolveSkillsPlan(
				planOptions(cwd, {
					agents: [],
					yes: true,
					interactive: false,
				}),
			),
		).rejects.toThrow(/No coding agents detected in this project/);
	});
});
