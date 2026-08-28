import { describe, expect, test, vi } from "vitest";

import type { AgentType } from "../mcp/agents.js";

import {
	bootstrapInitStep,
	childArgv,
	chooseYesAgentTooling,
	collectYesAgents,
	directoryIsEmpty,
	initYesSupportedAgents,
	noDetectedAgentsMessage,
	planAgentSteps,
	planExistingInit,
	planYesAgentSteps,
	projectContextFile,
	resolveInitAgentSetup,
	resolveYesAgentList,
	rewriteUnknownAgentArg,
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

describe("noDetectedAgentsMessage", () => {
	test("project miss does not mention --agent", () => {
		const message = noDetectedAgentsMessage({
			scope: "project",
			supported: ["cursor", "claude-code"],
			fix: "run-without-yes",
		});
		expect(message).toContain("No coding agents detected in this project.");
		expect(message).toContain("omit -y in a terminal");
		expect(message).toContain("cursor, claude-code");
		expect(message).not.toMatch(/--agent/);
	});

	test("global miss does not mention --agent", () => {
		const message = noDetectedAgentsMessage({
			scope: "global",
			supported: ["cursor"],
			fix: "run-without-yes",
		});
		expect(message).toContain("No coding agents detected.");
		expect(message).not.toContain("in this project");
		expect(message).not.toMatch(/--agent/);
	});

	test("names --agent when the command takes it", () => {
		const message = noDetectedAgentsMessage({
			scope: "project",
			supported: ["cursor"],
			fix: "run-without-yes",
			nameAgent: true,
		});
		expect(message).toContain("--agent <name>");
	});
});

describe("rewriteUnknownAgentArg", () => {
	test("names -y for init", () => {
		expect(
			rewriteUnknownAgentArg({
				message: "Unknown argument: agent",
				argv: ["node", "cli.js", "init", "--agent", "cursor"],
				cliName: "neon",
			}),
		).toBe(
			"neon init has no --agent. Pass -y to use detected agents, or run neon init in a terminal to pick.",
		);
	});

	test("does not treat a flag value as the command", () => {
		expect(
			rewriteUnknownAgentArg({
				message: "Unknown argument: agent",
				argv: [
					"node",
					"cli.js",
					"link",
					"--project-id",
					"init",
					"--agent",
					"cursor",
				],
				cliName: "neon",
			}),
		).toBe(
			"neon link has no --agent. Pass --project-id <id> to link without a TTY, or run neon link in a terminal.",
		);
		expect(
			rewriteUnknownAgentArg({
				message: "Unknown argument: agent",
				argv: [
					"node",
					"cli.js",
					"init",
					"--context-file",
					"bootstrap",
					"--agent",
					"cursor",
				],
				cliName: "neon",
			}),
		).toBe(
			"neon init has no --agent. Pass -y to use detected agents, or run neon init in a terminal to pick.",
		);
	});

	test("does not rewrite skills, plugins, or mcp", () => {
		for (const command of ["skills", "plugins", "mcp"] as const) {
			expect(
				rewriteUnknownAgentArg({
					message: "Unknown argument: agent",
					argv: ["node", "cli.js", command, "--agent", "cursor"],
					cliName: "neon",
				}),
			).toBeUndefined();
		}
	});

	test("names -a the same as --agent on init", () => {
		expect(
			rewriteUnknownAgentArg({
				message: "Unknown argument: a",
				argv: ["node", "cli.js", "init", "-a", "cursor"],
				cliName: "neon",
			}),
		).toBe(
			"neon init has no --agent. Pass -y to use detected agents, or run neon init in a terminal to pick.",
		);
	});

	test("names link and bootstrap replacements", () => {
		expect(
			rewriteUnknownAgentArg({
				message: "Unknown argument: agent",
				argv: ["node", "cli.js", "link", "--agent"],
				cliName: "neon",
			}),
		).toBe(
			"neon link has no --agent. Pass --project-id <id> to link without a TTY, or run neon link in a terminal.",
		);
		expect(
			rewriteUnknownAgentArg({
				message: "Unknown argument: agent",
				argv: ["node", "cli.js", "bootstrap", "--agent"],
				cliName: "neon",
			}),
		).toBe(
			"neon bootstrap has no --agent. Pass --template <id> and --default, or run neon bootstrap in a terminal.",
		);
	});
});

describe("initYesSupportedAgents", () => {
	test("includes plugin, skills, and MCP agents", () => {
		const ids = initYesSupportedAgents();
		expect(ids).toContain("cursor");
		expect(ids).toContain("vscode");
		expect(ids).toEqual([...new Set(ids)]);
	});
});

describe("resolveYesAgentList", () => {
	test("detected folders win over host", () => {
		expect(
			resolveYesAgentList({
				detected: ["vscode"],
				host: "cursor",
			}),
		).toEqual(["vscode"]);
	});

	test("host when detected is empty", () => {
		expect(
			resolveYesAgentList({
				detected: [],
				host: "cursor",
			}),
		).toEqual(["cursor"]);
	});

	test("all empty is empty", () => {
		expect(
			resolveYesAgentList({
				detected: [],
				host: null,
			}),
		).toEqual([]);
	});
});

describe("collectYesAgents", () => {
	test("does not ask host when detected is nonempty", async () => {
		const detectAgent = vi.fn((): AgentType | null => "cursor");
		await expect(
			collectYesAgents({
				detected: () => ["vscode"],
				detectAgent,
			}),
		).resolves.toEqual(["vscode"]);
		expect(detectAgent).not.toHaveBeenCalled();
	});

	test("host when detected is empty", async () => {
		await expect(
			collectYesAgents({
				detected: () => [],
				detectAgent: () => "cursor",
			}),
		).resolves.toEqual(["cursor"]);
	});

	test("rejected host is empty", async () => {
		await expect(
			collectYesAgents({
				detected: () => [],
				detectAgent: () => "cline",
				acceptHost: (id) => id !== "cline",
			}),
		).resolves.toEqual([]);
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
	test("plugin is plugins -y", () => {
		expect(
			planYesAgentSteps({
				setup: "plugin",
				agents: ["cursor", "codex"],
			}),
		).toEqual([["plugins", "-y"]]);
	});

	test("skills-mcp omits an empty step and pins MCP to the project", () => {
		expect(
			planYesAgentSteps({
				setup: "skills-mcp",
				skillsAgents: [],
				mcpAgents: ["vscode"],
			}),
		).toEqual([["mcp", "-y", "--project"]]);
		expect(
			planYesAgentSteps({
				setup: "skills-mcp",
				skillsAgents: ["vscode"],
				mcpAgents: ["vscode"],
			}),
		).toEqual([
			["skills", "-y"],
			["mcp", "-y", "--project"],
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

	test("no TTY asks for -y", async () => {
		await expect(
			resolveInitAgentSetup({
				interactive: false,
				pick: pickUnused,
			}),
		).rejects.toThrow(/Pass -y to use defaults/);
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
