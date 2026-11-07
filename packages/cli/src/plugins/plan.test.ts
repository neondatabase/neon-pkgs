import {
	chmodSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	rmSync,
	writeFileSync,
} from "node:fs";
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
	test("fails non-TTY without -y", () => {
		expect(() =>
			assertPluginsCanRun({
				yes: false,
				interactive: false,
				hasAgents: false,
			}),
		).toThrow(/Pass -y to install into detected agents/);
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
	test("-y with specified agents calls no prompts", async () => {
		const cwd = tmpDir();
		const plan = await resolvePluginsPlan(
			planOptions(cwd, {
				yes: true,
				interactive: false,
			}),
		);
		expect(plan).toEqual({
			agents: ["cursor"],
			skipped: [],
			unusableCommands: [],
			targets: [{ agents: ["cursor"], target: "cursor" }],
		});
	});

	test("non-TTY without -y succeeds when agents are specified", async () => {
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

	test("non-TTY without -y or named agents fails", async () => {
		const cwd = tmpDir();
		await expect(
			resolvePluginsPlan(
				planOptions(cwd, {
					yes: false,
					interactive: false,
					agents: [],
				}),
			),
		).rejects.toThrow(/Pass -y to install into detected agents/);
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
	});

	test("Kimi Code installs without --global", async () => {
		const cwd = tmpDir();
		const plan = await resolvePluginsPlan(
			planOptions(cwd, {
				yes: true,
				interactive: false,
				agents: ["kimi"],
			}),
		);
		expect(plan.targets).toEqual([
			{ agents: ["kimi-code"], target: "kimi" },
		]);
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
	});

	test("installs vscode alongside cursor without --global", async () => {
		const cwd = tmpDir();
		const plan = await resolvePluginsPlan(
			planOptions(cwd, {
				yes: true,
				interactive: false,
				agents: ["cursor", "vscode"],
			}),
		);
		expect(plan.agents).toEqual(["cursor", "vscode"]);
		expect(plan.targets).toEqual([
			{ agents: ["cursor"], target: "cursor" },
			{ agents: ["vscode"], target: "vscode" },
		]);
	});

	test("installs vscode alone without --global", async () => {
		const cwd = tmpDir();
		const plan = await resolvePluginsPlan(
			planOptions(cwd, {
				yes: true,
				interactive: false,
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
		expect(plan.agents).toEqual(["cursor"]);
	});

	test("-y with no project folders, host, or installed apps fails", async () => {
		const cwd = tmpDir();
		await expect(
			resolvePluginsPlan(
				planOptions(cwd, {
					agents: [],
					yes: true,
					interactive: false,
				}),
			),
		).rejects.toThrow(/^No coding agents detected\. Pass --agent <name>/);
	});

	test("project folders come before installed apps and the host", async () => {
		const cwd = tmpDir();
		mkdirSync(join(cwd, ".claude"));
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
		expect(plan.agents).toEqual(["claude-code"]);
		expect(detectInstalledAgents).not.toHaveBeenCalled();
	});

	test("project folders without a plugins mapping fall through to the host", async () => {
		const cwd = tmpDir();
		mkdirSync(join(cwd, ".opencode"));
		const plan = await resolvePluginsPlan(
			planOptions(cwd, {
				agents: [],
				yes: true,
				interactive: false,
				detectAgent: () => "cursor",
				detectInstalledAgents: async () => ["codex"],
			}),
		);
		expect(plan.agents).toEqual(["cursor"]);
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

	test("-y with no project folders uses a host VS Code", async () => {
		const cwd = tmpDir();
		const plan = await resolvePluginsPlan(
			planOptions(cwd, {
				agents: [],
				yes: true,
				interactive: false,
				detectAgent: () => "vscode",
				detectInstalledAgents: async () => ["cursor"],
			}),
		);
		expect(plan.agents).toEqual(["vscode"]);
	});

	test("-y with an unmapped host falls back to installed apps", async () => {
		const cwd = tmpDir();
		const plan = await resolvePluginsPlan(
			planOptions(cwd, {
				agents: [],
				yes: true,
				interactive: false,
				detectAgent: () => "cline",
				detectInstalledAgents: async () => ["cursor", "mcporter"],
			}),
		);
		expect(plan.agents).toEqual(["cursor"]);
	});

	test("-y with no project folder or host uses installed apps", async () => {
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

	test("the picker preselects project folders and never the host", async () => {
		const cwd = tmpDir();
		mkdirSync(join(cwd, ".cursor"));
		let selected: readonly AgentType[] | undefined;
		await resolvePluginsPlan(
			planOptions(cwd, {
				agents: [],
				detectAgent: () => "codex",
				detectInstalledAgents: async () => ["claude-code"],
				pickAgents: async (options) => {
					selected = options.selected;
					return ["cursor"];
				},
			}),
		);
		expect(selected).toEqual(["cursor"]);
	});

	test("the picker preselects installed apps when the project has no folders, not the host", async () => {
		const cwd = tmpDir();
		let selected: readonly AgentType[] | undefined;
		await resolvePluginsPlan(
			planOptions(cwd, {
				agents: [],
				detectAgent: () => "codex",
				detectInstalledAgents: async () => ["claude-code"],
				pickAgents: async (options) => {
					selected = options.selected;
					return ["claude-code"];
				},
			}),
		);
		expect(selected).toEqual(["claude-code"]);
	});
});

describe("resolvePluginsPlan agent commands", () => {
	const emptyPath = (): string => {
		const bin = join(tmpDir(), "bin");
		mkdirSync(bin);
		return bin;
	};

	test("--agent without the command fails before installing", async () => {
		const cwd = tmpDir();
		await expect(
			resolvePluginsPlan(
				planOptions(cwd, {
					agents: ["github-copilot-cli", "grok-build", "codex"],
					commandPath: emptyPath(),
				}),
			),
		).rejects.toThrow(
			'Cannot install the Neon plugin for GitHub Copilot CLI: "copilot" was not found on PATH. Install it or add it to PATH, then retry.\nCannot install the Neon plugin for Grok Build: "grok" was not found on PATH. Install it or add it to PATH, then retry.',
		);
	});

	test("--agent with the command on PATH plans the plugin", async () => {
		const cwd = tmpDir();
		const bin = emptyPath();
		const copilot = join(bin, "copilot");
		writeFileSync(
			copilot,
			'#!/bin/sh\necho "GitHub Copilot CLI 1.0.104."\n',
		);
		chmodSync(copilot, 0o755);
		const plan = await resolvePluginsPlan(
			planOptions(cwd, {
				agents: ["github-copilot-cli"],
				commandPath: bin,
			}),
		);
		expect(plan.targets).toEqual([
			{ agents: ["github-copilot-cli"], target: "github-copilot" },
		]);
		expect(plan.unusableCommands).toEqual([]);
	});

	test("--agent cursor in a terminal never runs a detected Copilot CLI", async () => {
		const cwd = tmpDir();
		const bin = emptyPath();
		const marker = join(cwd, "ran");
		writeFileSync(
			join(bin, "copilot"),
			`#!/bin/sh\nprintf ran > "${marker}"\n`,
		);
		chmodSync(join(bin, "copilot"), 0o755);
		const plan = await resolvePluginsPlan(
			planOptions(cwd, {
				agents: ["cursor"],
				interactive: true,
				commandPath: bin,
				detectInstalledAgents: async () => [
					"github-copilot-cli",
					"cursor",
				],
			}),
		);
		expect(plan.targets).toEqual([
			{ agents: ["cursor"], target: "cursor" },
		]);
		expect(existsSync(marker)).toBe(false);
	});

	test("--agent with an outdated Copilot CLI fails before installing", async () => {
		const cwd = tmpDir();
		const bin = emptyPath();
		const copilot = join(bin, "copilot");
		writeFileSync(
			copilot,
			'#!/bin/sh\necho "GitHub Copilot CLI 0.0.399."\n',
		);
		chmodSync(copilot, 0o755);
		await expect(
			resolvePluginsPlan(
				planOptions(cwd, {
					agents: ["github-copilot-cli"],
					commandPath: bin,
				}),
			),
		).rejects.toThrow(
			'Cannot install the Neon plugin for GitHub Copilot CLI: "copilot" is GitHub Copilot CLI 0.0.399, older than the 0.0.400 its plugin needs. Install or update GitHub Copilot CLI, then retry.',
		);
	});
});
