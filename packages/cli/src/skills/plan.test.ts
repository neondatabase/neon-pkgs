import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

import type { AgentType } from "../mcp/agents.js";
import {
	AGENT_SKILLS_SOURCE,
	defaultSkillEntries,
	NEON_SKILL_CATALOG,
} from "./catalog.js";
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
		skills: [],
		yes: false,
		cwd,
		interactive: true,
		pickSkills: async () => {
			throw new Error("skill prompt");
		},
		pickAgents: async () => {
			throw new Error("agent prompt");
		},
		detectAgent: () => null,
		detectInstalledAgents: async () => [],
		...overrides,
	};
}

describe("assertSkillsCanRun", () => {
	test("fails non-TTY without -y or named skills", () => {
		expect(() =>
			assertSkillsCanRun({
				yes: false,
				interactive: false,
				action: "install",
			}),
		).toThrow(/Pass -y to install the default skills/);
		expect(() =>
			assertSkillsCanRun({
				yes: false,
				interactive: false,
				action: "update",
			}),
		).toThrow(/Pass -y to update installed skills/);
	});

	test("allows named skills without -y", () => {
		expect(() =>
			assertSkillsCanRun({
				yes: false,
				interactive: false,
				action: "install",
				hasSkills: true,
			}),
		).not.toThrow();
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
	test("-y is this directory, specified agents, default skills, and calls no prompts", async () => {
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
			invocations: [
				{
					source: AGENT_SKILLS_SOURCE,
					skills: defaultSkillEntries().map((item) => item.skill),
				},
			],
		});
	});

	test("non-TTY without -y fails even when agents are specified", async () => {
		const cwd = tmpDir();
		await expect(
			resolveSkillsPlan(
				planOptions(cwd, {
					yes: false,
					interactive: false,
					agents: ["cursor"],
				}),
			),
		).rejects.toThrow(/Pass -y to install the default skills/);
	});

	test("--global is user-level", async () => {
		const cwd = tmpDir();
		const plan = await resolveSkillsPlan(
			planOptions(cwd, { yes: true, interactive: false, global: true }),
		);
		expect(plan.scope).toBe("global");
	});

	test("--skill skips the skill picker", async () => {
		const cwd = tmpDir();
		const plan = await resolveSkillsPlan(
			planOptions(cwd, {
				skills: ["neon", "neon-postgres-agent-platforms"],
				yes: false,
				interactive: false,
			}),
		);
		expect(plan.invocations).toEqual([
			{ source: AGENT_SKILLS_SOURCE, skills: ["neon"] },
			{
				source: "neondatabase/neon-for-agent-platforms",
				skills: ["neon-postgres-agent-platforms"],
			},
		]);
	});

	test("rejects unknown --skill before asking agents", async () => {
		const cwd = tmpDir();
		let asked = false;
		await expect(
			resolveSkillsPlan(
				planOptions(cwd, {
					skills: ["eve"],
					yes: false,
					interactive: true,
					pickAgents: async () => {
						asked = true;
						return ["cursor"];
					},
				}),
			),
		).rejects.toThrow(/Unknown skill: "eve"/);
		expect(asked).toBe(false);
	});

	test("rejects --skill * and unknown skill names", async () => {
		const cwd = tmpDir();
		await expect(
			resolveSkillsPlan(
				planOptions(cwd, {
					skills: ["*"],
					yes: true,
					interactive: false,
				}),
			),
		).rejects.toThrow(/does not accept --skill \*/);
		await expect(
			resolveSkillsPlan(
				planOptions(cwd, {
					skills: ["eve"],
					yes: true,
					interactive: false,
				}),
			),
		).rejects.toThrow(/Unknown skill: "eve"/);
	});

	test("specified agents skip the agent picker and still ask for skills", async () => {
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
		const error = await resolveSkillsPlan(
			planOptions(cwd, {
				agents: [],
				yes: true,
				interactive: false,
			}),
		).catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(Error);
		if (!(error instanceof Error)) {
			throw new Error("expected Error");
		}
		expect(error.message).toMatch(
			/No coding agents detected in this project/,
		);
		expect(error.message).toMatch(/--agent <name>/);
		expect(error.message).toMatch(/omit -y in a terminal/);
	});

	test("-y uses the host CLI agent when the project has no folders", async () => {
		const cwd = tmpDir();
		const detectInstalledAgents = vi.fn(
			async (): Promise<readonly AgentType[]> => ["codex"],
		);
		const plan = await resolveSkillsPlan(
			planOptions(cwd, {
				agents: [],
				yes: true,
				interactive: false,
				detectAgent: () => "cursor",
				detectInstalledAgents,
			}),
		);
		expect(plan.agents).toEqual(["cursor"]);
		expect(detectInstalledAgents).not.toHaveBeenCalled();
	});

	test("-y does not use installed apps when there is no project folder or host", async () => {
		const cwd = tmpDir();
		const detectInstalledAgents = vi.fn(
			async (): Promise<readonly AgentType[]> => ["codex"],
		);
		await expect(
			resolveSkillsPlan(
				planOptions(cwd, {
					agents: [],
					yes: true,
					interactive: false,
					detectInstalledAgents,
				}),
			),
		).rejects.toThrow(/from a supported agent/);
		expect(detectInstalledAgents).not.toHaveBeenCalled();
	});

	test("--skill without -y and no detected agents asks for -y", async () => {
		const cwd = tmpDir();
		await expect(
			resolveSkillsPlan(
				planOptions(cwd, {
					agents: [],
					skills: ["neon"],
					yes: false,
					interactive: false,
				}),
			),
		).rejects.toThrow(/Pass -y to use project folders/);
	});

	test("-y --global uses installed apps over host", async () => {
		const cwd = tmpDir();
		const detectAgent = vi.fn((): AgentType | null => "claude-code");
		const plan = await resolveSkillsPlan(
			planOptions(cwd, {
				agents: [],
				yes: true,
				interactive: false,
				global: true,
				detectAgent,
				detectInstalledAgents: async () => ["codex"],
			}),
		);
		expect(plan.agents).toEqual(["codex"]);
		expect(detectAgent).not.toHaveBeenCalled();
	});

	test("-y --global uses the host when no apps are installed", async () => {
		const cwd = tmpDir();
		const plan = await resolveSkillsPlan(
			planOptions(cwd, {
				agents: [],
				yes: true,
				interactive: false,
				global: true,
				detectAgent: () => "cursor",
				detectInstalledAgents: async () => [],
			}),
		);
		expect(plan.agents).toEqual(["cursor"]);
	});

	test("-y --global with no apps or host fails", async () => {
		const cwd = tmpDir();
		const error = await resolveSkillsPlan(
			planOptions(cwd, {
				agents: [],
				yes: true,
				interactive: false,
				global: true,
				detectInstalledAgents: async () => [],
			}),
		).catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(Error);
		if (!(error instanceof Error)) {
			throw new Error("expected Error");
		}
		expect(error.message).toMatch(/^No coding agents detected\./);
		expect(error.message).not.toContain("in this project");
		expect(error.message).toMatch(/--agent <name>/);
	});

	test("-y does not ask host when the project has folders", async () => {
		const cwd = tmpDir();
		mkdirSync(join(cwd, ".cursor"));
		const detectAgent = vi.fn((): AgentType | null => "claude-code");
		const detectInstalledAgents = vi.fn(
			async (): Promise<readonly AgentType[]> => ["codex"],
		);
		const plan = await resolveSkillsPlan(
			planOptions(cwd, {
				agents: [],
				yes: true,
				interactive: false,
				detectAgent,
				detectInstalledAgents,
			}),
		);
		expect(plan.agents).toEqual(["cursor"]);
		expect(detectAgent).not.toHaveBeenCalled();
		expect(detectInstalledAgents).not.toHaveBeenCalled();
	});
});
