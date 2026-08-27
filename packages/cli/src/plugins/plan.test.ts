import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

import type { AgentType } from "../mcp/agents.js";
import {
	assertPluginsCanRun,
	type ResolvePluginsPlanOptions,
	resolvePluginsPlan,
} from "./plan.js";

const dirs: string[] = [];

afterEach(() => {
	for (const dir of dirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function tmpDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "neon-plugins-plan-"));
	dirs.push(dir);
	return dir;
}

function planOptions(
	cwd: string,
	overrides: Partial<ResolvePluginsPlanOptions> = {},
): ResolvePluginsPlanOptions {
	return {
		global: false,
		agents: ["cursor"],
		yes: false,
		cwd,
		interactive: true,
		pickAgents: async () => {
			throw new Error("agent prompt");
		},
		detectAgent: () => null,
		detectInstalledAgents: async () => [],
		...overrides,
	};
}

describe("assertPluginsCanRun", () => {
	test("fails non-TTY without -y or --agent", () => {
		expect(() =>
			assertPluginsCanRun({
				yes: false,
				interactive: false,
				hasAgents: false,
			}),
		).toThrow(/Pass -y to install into detected agents, or --agent/);
	});

	test("allows named agents without -y", () => {
		expect(() =>
			assertPluginsCanRun({
				yes: false,
				interactive: false,
				hasAgents: true,
			}),
		).not.toThrow();
	});

	test("allows -y or a TTY", () => {
		expect(() =>
			assertPluginsCanRun({
				yes: true,
				interactive: false,
				hasAgents: false,
			}),
		).not.toThrow();
		expect(() =>
			assertPluginsCanRun({
				yes: false,
				interactive: true,
				hasAgents: false,
			}),
		).not.toThrow();
	});
});

describe("resolvePluginsPlan", () => {
	test("-y is project-scoped, specified agents, and calls no prompts", async () => {
		const cwd = tmpDir();
		const plan = await resolvePluginsPlan(
			planOptions(cwd, {
				yes: true,
				interactive: false,
			}),
		);
		expect(plan).toEqual({
			scope: "project",
			agents: ["cursor"],
			skipped: [],
			userScopeSkipped: [],
			targets: [{ agents: ["cursor"], target: "cursor" }],
		});
	});

	test("non-TTY without -y succeeds when --agent is set", async () => {
		const cwd = tmpDir();
		const plan = await resolvePluginsPlan(
			planOptions(cwd, {
				yes: false,
				interactive: false,
				agents: ["cursor"],
			}),
		);
		expect(plan.agents).toEqual(["cursor"]);
		expect(plan.targets).toEqual([
			{ agents: ["cursor"], target: "cursor" },
		]);
	});

	test("non-TTY without -y or --agent fails", async () => {
		const cwd = tmpDir();
		await expect(
			resolvePluginsPlan(
				planOptions(cwd, {
					yes: false,
					interactive: false,
					agents: [],
				}),
			),
		).rejects.toThrow(
			/Pass -y to install into detected agents, or --agent/,
		);
	});

	test("--global is user-level", async () => {
		const cwd = tmpDir();
		const plan = await resolvePluginsPlan(
			planOptions(cwd, { yes: true, interactive: false, global: true }),
		);
		expect(plan.scope).toBe("global");
	});

	test("rejects plugins-CLI-only agent names", async () => {
		const cwd = tmpDir();
		await expect(
			resolvePluginsPlan(
				planOptions(cwd, {
					yes: true,
					interactive: false,
					agents: ["eve"],
				}),
			),
		).rejects.toThrow(/Unknown agent: "eve"/);
		await expect(
			resolvePluginsPlan(
				planOptions(cwd, {
					yes: true,
					interactive: false,
					agents: ["kimi"],
				}),
			),
		).rejects.toThrow(/Unknown agent: "kimi"/);
	});

	test("rejects --agent *", async () => {
		const cwd = tmpDir();
		await expect(
			resolvePluginsPlan(
				planOptions(cwd, {
					yes: true,
					interactive: false,
					agents: ["*"],
				}),
			),
		).rejects.toThrow(/does not accept --agent \*/);
	});

	test("skips MCP agents that cannot install plugins", async () => {
		const cwd = tmpDir();
		const plan = await resolvePluginsPlan(
			planOptions(cwd, {
				yes: true,
				interactive: false,
				agents: ["cursor", "mcporter"],
			}),
		);
		expect(plan.agents).toEqual(["cursor"]);
		expect(plan.skipped).toEqual(["mcporter"]);
		expect(plan.userScopeSkipped).toEqual([]);
	});

	test("skips user-level-only agents at project scope when others remain", async () => {
		const cwd = tmpDir();
		const plan = await resolvePluginsPlan(
			planOptions(cwd, {
				yes: true,
				interactive: false,
				agents: ["cursor", "vscode"],
			}),
		);
		expect(plan.agents).toEqual(["cursor"]);
		expect(plan.userScopeSkipped).toEqual(["vscode"]);
		expect(plan.targets).toEqual([
			{ agents: ["cursor"], target: "cursor" },
		]);
	});

	test("fails when every selected agent is user-level-only at project scope", async () => {
		const cwd = tmpDir();
		await expect(
			resolvePluginsPlan(
				planOptions(cwd, {
					yes: true,
					interactive: false,
					agents: ["vscode"],
				}),
			),
		).rejects.toThrow(/Pass --global/);
	});

	test("installs vscode at user-level", async () => {
		const cwd = tmpDir();
		const plan = await resolvePluginsPlan(
			planOptions(cwd, {
				yes: true,
				interactive: false,
				global: true,
				agents: ["vscode"],
			}),
		);
		expect(plan.agents).toEqual(["vscode"]);
		expect(plan.targets).toEqual([
			{ agents: ["vscode"], target: "vscode" },
		]);
	});

	test("dedupes Claude Desktop onto claude-code", async () => {
		const cwd = tmpDir();
		const plan = await resolvePluginsPlan(
			planOptions(cwd, {
				yes: true,
				interactive: false,
				agents: ["claude", "claude-desktop"],
			}),
		);
		expect(plan.agents).toEqual(["claude-code", "claude-desktop"]);
		expect(plan.targets).toEqual([
			{
				agents: ["claude-code", "claude-desktop"],
				target: "claude-code",
			},
		]);
	});

	test("fails when every selected agent lacks a plugins mapping", async () => {
		const cwd = tmpDir();
		await expect(
			resolvePluginsPlan(
				planOptions(cwd, {
					yes: true,
					interactive: false,
					agents: ["mcporter"],
				}),
			),
		).rejects.toThrow(/None of the selected agents can install plugins/);
	});

	test("interactive asks agents", async () => {
		const cwd = tmpDir();
		mkdirSync(join(cwd, ".cursor"));
		let asked = false;
		const plan = await resolvePluginsPlan(
			planOptions(cwd, {
				agents: [],
				pickAgents: async (options) => {
					asked = true;
					expect(options.selected).toEqual(["cursor"]);
					return ["cursor"];
				},
			}),
		);
		expect(asked).toBe(true);
		expect(plan.scope).toBe("project");
		expect(plan.agents).toEqual(["cursor"]);
	});

	test("non-interactive project with no folder agents fails", async () => {
		const cwd = tmpDir();
		await expect(
			resolvePluginsPlan(
				planOptions(cwd, {
					agents: [],
					yes: true,
					interactive: false,
				}),
			),
		).rejects.toThrow(/No coding agents detected in this project/);
	});

	test("-y uses the host CLI agent when the project has no folders", async () => {
		const cwd = tmpDir();
		const detectInstalledAgents = vi.fn(
			async (): Promise<readonly AgentType[]> => ["codex"],
		);
		const plan = await resolvePluginsPlan(
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

	test("-y host VS Code at project scope asks for --global", async () => {
		const cwd = tmpDir();
		await expect(
			resolvePluginsPlan(
				planOptions(cwd, {
					agents: [],
					yes: true,
					interactive: false,
					detectAgent: () => "vscode",
					detectInstalledAgents: async () => ["cursor"],
				}),
			),
		).rejects.toThrow(/plugins are user-level. Pass --global/);
	});

	test("-y host without a plugins mapping falls through to installed apps", async () => {
		const cwd = tmpDir();
		const plan = await resolvePluginsPlan(
			planOptions(cwd, {
				agents: [],
				yes: true,
				interactive: false,
				detectAgent: () => "cline",
				detectInstalledAgents: async () => ["cursor"],
			}),
		);
		expect(plan.agents).toEqual(["cursor"]);
	});

	test("-y uses installed apps when there is no project folder or host", async () => {
		const cwd = tmpDir();
		const plan = await resolvePluginsPlan(
			planOptions(cwd, {
				agents: [],
				yes: true,
				interactive: false,
				detectInstalledAgents: async () => ["codex"],
			}),
		);
		expect(plan.agents).toEqual(["codex"]);
	});
});
