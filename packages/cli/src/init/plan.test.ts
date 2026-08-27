import { describe, expect, test, vi } from "vitest";

import type { AgentType } from "../mcp/agents.js";

import {
	bootstrapInitStep,
	childArgv,
	chooseYesAgentTooling,
	collectYesAgents,
	directoryIsEmpty,
	planAgentSteps,
	planExistingInit,
	planYesAgentSteps,
	projectContextFile,
	resolveInitAgentSetup,
	resolveYesAgentList,
} from "./plan.js";

describe("directoryIsEmpty", () => {
	test("treats an empty list as empty", () => {
		expect(directoryIsEmpty([])).toBe(true);
	});

	test("ignores .git", () => {
		expect(directoryIsEmpty([".git"])).toBe(true);
	});

	test("a README is not empty", () => {
		expect(directoryIsEmpty(["README.md"])).toBe(false);
	});

	test(".git plus anything else is not empty", () => {
		expect(directoryIsEmpty([".git", "package.json"])).toBe(false);
	});
});

describe("bootstrapInitStep", () => {
	test("interactive empty dir is bootstrap .", () => {
		expect(bootstrapInitStep(false)).toEqual(["bootstrap", "."]);
	});

	test("-y empty dir is bootstrap . --default", () => {
		expect(bootstrapInitStep(true)).toEqual([
			"bootstrap",
			".",
			"--default",
		]);
	});
});

describe("projectContextFile", () => {
	test("an absolute parent context file does not follow into the scaffold", () => {
		expect(
			projectContextFile("/tmp/my-app", "/Users/me/project/.neon"),
		).toBe("/tmp/my-app/.neon");
	});

	test("a relative context file is resolved against the scaffold", () => {
		expect(projectContextFile("/tmp/my-app", ".neon")).toBe(
			"/tmp/my-app/.neon",
		);
	});

	test("an absolute path already in the scaffold is kept", () => {
		expect(
			projectContextFile("/tmp/my-app", "/tmp/my-app/custom.neon"),
		).toBe("/tmp/my-app/custom.neon");
	});
});

describe("planAgentSteps", () => {
	test("plugin never includes skills or mcp", () => {
		expect(planAgentSteps({ yes: true, agentSetup: "plugin" })).toEqual([
			["plugins", "-y"],
		]);
	});

	test("skills-mcp never includes plugins", () => {
		expect(planAgentSteps({ yes: true, agentSetup: "skills-mcp" })).toEqual(
			[
				["skills", "-y"],
				["mcp", "-y"],
			],
		);
	});

	test("skip is empty", () => {
		expect(planAgentSteps({ yes: false, agentSetup: "skip" })).toEqual([]);
	});
});

describe("planExistingInit", () => {
	test("skills-mcp unlinked interactive: skills, mcp, link, config init", () => {
		expect(
			planExistingInit({
				linked: false,
				yes: false,
				agentSetup: "skills-mcp",
			}),
		).toEqual([["skills"], ["mcp"], ["link"], ["config", "init"]]);
	});

	test("skills-mcp unlinked -y", () => {
		expect(
			planExistingInit({
				linked: false,
				yes: true,
				agentSetup: "skills-mcp",
			}),
		).toEqual([
			["skills", "-y"],
			["mcp", "-y"],
			["link", "--yes"],
			["config", "init", "--services", "none"],
		]);
	});

	test("skills-mcp linked: skills, mcp, config init", () => {
		expect(
			planExistingInit({
				linked: true,
				yes: false,
				agentSetup: "skills-mcp",
			}),
		).toEqual([["skills"], ["mcp"], ["config", "init"]]);
	});

	test("plugin unlinked interactive: plugins, link, config init", () => {
		expect(
			planExistingInit({
				linked: false,
				yes: false,
				agentSetup: "plugin",
			}),
		).toEqual([["plugins"], ["link"], ["config", "init"]]);
	});

	test("plugin unlinked -y", () => {
		expect(
			planExistingInit({
				linked: false,
				yes: true,
				agentSetup: "plugin",
			}),
		).toEqual([
			["plugins", "-y"],
			["link", "--yes"],
			["config", "init", "--services", "none"],
		]);
	});

	test("plugin linked: plugins and config init", () => {
		expect(
			planExistingInit({
				linked: true,
				yes: false,
				agentSetup: "plugin",
			}),
		).toEqual([["plugins"], ["config", "init"]]);
	});

	test("skip unlinked: link and config init", () => {
		expect(
			planExistingInit({
				linked: false,
				yes: false,
				agentSetup: "skip",
			}),
		).toEqual([["link"], ["config", "init"]]);
	});

	test("skip unlinked -y", () => {
		expect(
			planExistingInit({
				linked: false,
				yes: true,
				agentSetup: "skip",
			}),
		).toEqual([
			["link", "--yes"],
			["config", "init", "--services", "none"],
		]);
	});

	test("skip linked: config init only", () => {
		expect(
			planExistingInit({
				linked: true,
				yes: false,
				agentSetup: "skip",
			}),
		).toEqual([["config", "init"]]);
	});
});

describe("resolveYesAgentList", () => {
	test("project folders win over host and installed", () => {
		expect(
			resolveYesAgentList({
				project: ["vscode"],
				host: "cursor",
				installed: ["codex"],
			}),
		).toEqual(["vscode"]);
	});

	test("host wins over installed when the project is empty", () => {
		expect(
			resolveYesAgentList({
				project: [],
				host: "cursor",
				installed: ["codex", "claude-code"],
			}),
		).toEqual(["cursor"]);
	});

	test("installed is last", () => {
		expect(
			resolveYesAgentList({
				project: [],
				host: null,
				installed: ["codex", "vscode", "codex"],
			}),
		).toEqual(["codex", "vscode"]);
	});

	test("all empty is empty", () => {
		expect(
			resolveYesAgentList({
				project: [],
				host: null,
				installed: [],
			}),
		).toEqual([]);
	});
});

describe("collectYesAgents", () => {
	test("does not ask host or installed when the project is nonempty", async () => {
		const detectAgent = vi.fn((): AgentType | null => "cursor");
		const detectInstalled = vi.fn(
			async (): Promise<readonly AgentType[]> => ["codex"],
		);
		await expect(
			collectYesAgents({
				project: () => ["vscode"],
				detectAgent,
				detectInstalled,
			}),
		).resolves.toEqual(["vscode"]);
		expect(detectAgent).not.toHaveBeenCalled();
		expect(detectInstalled).not.toHaveBeenCalled();
	});

	test("host wins over installed", async () => {
		const detectInstalled = vi.fn(
			async (): Promise<readonly AgentType[]> => ["codex"],
		);
		await expect(
			collectYesAgents({
				project: () => [],
				detectAgent: () => "cursor",
				detectInstalled,
			}),
		).resolves.toEqual(["cursor"]);
		expect(detectInstalled).not.toHaveBeenCalled();
	});

	test("rejected host falls through to installed", async () => {
		await expect(
			collectYesAgents({
				project: () => [],
				detectAgent: () => "cline",
				detectInstalled: async () => ["cursor"],
				acceptHost: (id) => id !== "cline",
			}),
		).resolves.toEqual(["cursor"]);
	});
});

describe("chooseYesAgentTooling", () => {
	test("skip when nothing is detected", () => {
		expect(chooseYesAgentTooling([])).toEqual({ setup: "skip" });
	});

	test("plugin keeps project-plugin agents and drops vscode", () => {
		expect(chooseYesAgentTooling(["cursor", "vscode", "codex"])).toEqual({
			setup: "plugin",
			agents: ["cursor", "codex"],
		});
	});

	test("vscode-only is skills and MCP", () => {
		expect(chooseYesAgentTooling(["vscode"])).toEqual({
			setup: "skills-mcp",
			skillsAgents: ["vscode"],
			mcpAgents: ["vscode"],
		});
	});

	test("mcporter-only is MCP only", () => {
		expect(chooseYesAgentTooling(["mcporter"])).toEqual({
			setup: "skills-mcp",
			skillsAgents: [],
			mcpAgents: ["mcporter"],
		});
	});

	test("vscode plus mcporter splits skills and MCP", () => {
		expect(chooseYesAgentTooling(["vscode", "mcporter"])).toEqual({
			setup: "skills-mcp",
			skillsAgents: ["vscode"],
			mcpAgents: ["vscode", "mcporter"],
		});
	});
});

describe("planYesAgentSteps", () => {
	test("plugin passes --agent", () => {
		expect(
			planYesAgentSteps({
				setup: "plugin",
				agents: ["cursor", "codex"],
			}),
		).toEqual([["plugins", "-y", "--agent", "cursor", "--agent", "codex"]]);
	});

	test("skills-mcp omits an empty step", () => {
		expect(
			planYesAgentSteps({
				setup: "skills-mcp",
				skillsAgents: [],
				mcpAgents: ["mcporter"],
			}),
		).toEqual([["mcp", "-y", "--agent", "mcporter"]]);
		expect(
			planYesAgentSteps({
				setup: "skills-mcp",
				skillsAgents: ["vscode"],
				mcpAgents: ["vscode", "mcporter"],
			}),
		).toEqual([
			["skills", "-y", "--agent", "vscode"],
			["mcp", "-y", "--agent", "vscode", "--agent", "mcporter"],
		]);
	});

	test("skip is empty", () => {
		expect(planYesAgentSteps({ setup: "skip" })).toEqual([]);
	});
});

describe("resolveInitAgentSetup", () => {
	const pickUnused = async () => {
		throw new Error("pick should not run");
	};

	test("interactive uses pick", async () => {
		await expect(
			resolveInitAgentSetup({
				interactive: true,
				pick: async () => "skip",
			}),
		).resolves.toBe("skip");
	});

	test("no TTY keeps skills-mcp", async () => {
		await expect(
			resolveInitAgentSetup({
				interactive: false,
				pick: pickUnused,
			}),
		).resolves.toBe("skills-mcp");
	});
});

describe("childArgv", () => {
	const host = "https://console.neon.tech/api/v2";

	test("forwards account and context, not --output", () => {
		expect(
			childArgv(["skills", "-y"], {
				configDir: "/cfg",
				profile: "work",
				apiHost: host,
				contextFile: "/app/.neon",
				analytics: false,
			}),
		).toEqual([
			"skills",
			"-y",
			"--config-dir",
			"/cfg",
			"--profile",
			"work",
			"--api-host",
			host,
			"--context-file",
			"/app/.neon",
			"--no-analytics",
		]);
	});

	test("omits optional flags when unset", () => {
		expect(
			childArgv(["mcp"], {
				apiHost: host,
				contextFile: "/app/.neon",
			}),
		).toEqual(["mcp", "--api-host", host, "--context-file", "/app/.neon"]);
	});

	test("forwards globals onto plugins", () => {
		expect(
			childArgv(["plugins", "-y"], {
				apiHost: host,
				contextFile: "/app/.neon",
			}),
		).toEqual([
			"plugins",
			"-y",
			"--api-host",
			host,
			"--context-file",
			"/app/.neon",
		]);
	});

	test("forwards --services none onto config init", () => {
		expect(
			childArgv(["config", "init", "--services", "none"], {
				apiHost: host,
				contextFile: "/app/.neon",
			}),
		).toEqual([
			"config",
			"init",
			"--services",
			"none",
			"--api-host",
			host,
			"--context-file",
			"/app/.neon",
		]);
	});
});
