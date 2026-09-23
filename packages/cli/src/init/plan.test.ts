import { describe, expect, test, vi } from "vitest";

import type { AgentType } from "../mcp/agents.js";

import {
	assertNamedAgentTooling,
	bootstrapInitStep,
	chooseYesAgentTooling,
	collectYesAgents,
	directoryIsEmpty,
	initYesSupportedAgents,
	linkInputArgv,
	namedAgentsNeedSplit,
	noDetectedAgentsMessage,
	planAgentSteps,
	planConfigInitStep,
	planLinkStep,
	planToolingSteps,
	planYesAgentSteps,
	postScaffoldActions,
	projectContextFile,
	resolveInitAgentSetup,
	resolveNamedAgents,
	resolveYesAgentList,
	rewriteUnknownAgentArg,
	splitInitTooling,
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

	test("forwards named agents", () => {
		expect(bootstrapInitStep(true, ["cursor", "claude-code"])).toEqual([
			"bootstrap",
			".",
			"--default",
			"--agent",
			"cursor",
			"--agent",
			"claude-code",
		]);
		expect(bootstrapInitStep(false, ["vscode"])).toEqual([
			"bootstrap",
			".",
			"--agent",
			"vscode",
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

describe("postScaffoldActions", () => {
	test("puts dependency install last when link does not need neon.ts", () => {
		expect(
			postScaffoldActions({
				git: true,
				agentSetup: "plugin",
				install: true,
				link: true,
				hasNeonConfig: false,
			}),
		).toEqual(["git", "agent", "link", "install"]);
	});

	test("installs before link when the template has neon.ts", () => {
		expect(
			postScaffoldActions({
				git: true,
				agentSetup: "skills-mcp",
				install: true,
				link: true,
				hasNeonConfig: true,
			}),
		).toEqual(["git", "agent", "install", "link"]);
	});

	test("skips link when neon.ts would need deps that will not be installed", () => {
		expect(
			postScaffoldActions({
				git: false,
				agentSetup: "skip",
				install: false,
				link: true,
				hasNeonConfig: true,
			}),
		).toEqual([]);
	});

	test("links without install when there is no neon.ts", () => {
		expect(
			postScaffoldActions({
				git: false,
				agentSetup: "skip",
				install: false,
				link: true,
				hasNeonConfig: false,
			}),
		).toEqual(["link"]);
	});

	test("install only is just install", () => {
		expect(
			postScaffoldActions({
				git: false,
				agentSetup: "skip",
				install: true,
				link: false,
				hasNeonConfig: true,
			}),
		).toEqual(["install"]);
	});
});

describe("planAgentSteps", () => {
	test("plugin never includes skills or mcp", () => {
		expect(planAgentSteps({ yes: true, agentSetup: "plugin" })).toEqual([
			{ kind: "plugins", options: { yes: true } },
		]);
	});

	test("skills-mcp never includes plugins", () => {
		expect(planAgentSteps({ yes: true, agentSetup: "skills-mcp" })).toEqual(
			[
				{ kind: "skills", options: { yes: true } },
				{ kind: "mcp", options: { yes: true } },
			],
		);
	});

	test("skip is empty", () => {
		expect(planAgentSteps({ yes: false, agentSetup: "skip" })).toEqual([]);
	});
});

describe("planLinkStep", () => {
	test("always suppresses the nested neon.ts offer", () => {
		expect(planLinkStep({ yes: false })).toEqual(["link", "--no-config"]);
		expect(planLinkStep({ yes: true })).toEqual([
			"link",
			"--yes",
			"--no-config",
		]);
	});
});

describe("planConfigInitStep", () => {
	test("interactive has no services flag", () => {
		expect(planConfigInitStep({ yes: false })).toEqual(["config", "init"]);
	});

	test("-y uses none", () => {
		expect(planConfigInitStep({ yes: true })).toEqual([
			"config",
			"init",
			"--services",
			"none",
		]);
	});

	test("explicit services win over -y", () => {
		expect(planConfigInitStep({ yes: true, services: ["auth"] })).toEqual([
			"config",
			"init",
			"--services",
			"auth",
		]);
	});

	test("empty selection is the none token, not an empty --services value", () => {
		expect(planConfigInitStep({ yes: false, services: [] })).toEqual([
			"config",
			"init",
			"--services",
			"none",
		]);
	});
});

describe("linkInputArgv", () => {
	test("omits unset fields", () => {
		expect(linkInputArgv({})).toEqual([]);
	});

	test("emits flags in a stable order", () => {
		expect(
			linkInputArgv({
				projectId: "proj-1",
				orgId: "org-1",
				branch: "main",
			}),
		).toEqual([
			"--org-id",
			"org-1",
			"--project-id",
			"proj-1",
			"--branch",
			"main",
		]);
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
	test("names --project-id for link", () => {
		expect(
			rewriteUnknownAgentArg({
				message: "Unknown argument: agent",
				argv: ["node", "cli.js", "link", "--agent", "cursor"],
				cliName: "neon",
			}),
		).toBe(
			"neon link has no --agent. Pass --project-id <id> to link without a TTY, or run neon link in a terminal.",
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
					"--org-id",
					"init",
					"link",
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
					"--force-auth",
					"link",
					"--agent",
					"cursor",
				],
				cliName: "neon",
			}),
		).toBe(
			"neon link has no --agent. Pass --project-id <id> to link without a TTY, or run neon link in a terminal.",
		);
	});

	test("does not rewrite skills, plugins, mcp, init, or bootstrap", () => {
		for (const command of [
			"skills",
			"plugins",
			"mcp",
			"init",
			"bootstrap",
		] as const) {
			expect(
				rewriteUnknownAgentArg({
					message: "Unknown argument: agent",
					argv: ["node", "cli.js", command, "--agent", "cursor"],
					cliName: "neon",
				}),
			).toBeUndefined();
		}
	});

	test("names -a the same as --agent on link", () => {
		expect(
			rewriteUnknownAgentArg({
				message: "Unknown argument: a",
				argv: ["node", "cli.js", "link", "-a", "cursor"],
				cliName: "neon",
			}),
		).toBe(
			"neon link has no --agent. Pass --project-id <id> to link without a TTY, or run neon link in a terminal.",
		);
	});

	test("rewrites a bare --agent on link", () => {
		expect(
			rewriteUnknownAgentArg({
				message: "Unknown argument: agent",
				argv: ["node", "cli.js", "link", "--agent"],
				cliName: "neon",
			}),
		).toBe(
			"neon link has no --agent. Pass --project-id <id> to link without a TTY, or run neon link in a terminal.",
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

	test("windsurf is skills and global MCP", () => {
		expect(chooseYesAgentTooling(["windsurf"])).toEqual({
			setup: "skills-mcp",
			skillsAgents: ["windsurf"],
			mcpAgents: ["windsurf"],
		});
	});

	test("plugin scope does not change MCP config location", () => {
		expect(splitInitTooling(["windsurf"], "project", "global")).toEqual({
			setup: "skills-mcp",
			skillsAgents: ["windsurf"],
			mcpAgents: ["windsurf"],
		});
	});
});

describe("namedAgentsNeedSplit", () => {
	test("plugin-only names do not split", () => {
		const tooling = chooseYesAgentTooling(["cursor", "claude-code"]);
		expect(namedAgentsNeedSplit(["cursor", "claude-code"], tooling)).toBe(
			false,
		);
	});

	test("cursor plus vscode splits plugin from skills", () => {
		const tooling = chooseYesAgentTooling(["cursor", "vscode"]);
		expect(namedAgentsNeedSplit(["cursor", "vscode"], tooling)).toBe(true);
	});

	test("vscode plus mcporter does not split", () => {
		const tooling = chooseYesAgentTooling(["vscode", "mcporter"]);
		expect(namedAgentsNeedSplit(["vscode", "mcporter"], tooling)).toBe(
			false,
		);
	});
});

describe("assertNamedAgentTooling", () => {
	test("plugin-only names pass", () => {
		expect(() =>
			assertNamedAgentTooling(["cursor", "claude-code"]),
		).not.toThrow();
	});

	test("cursor plus vscode is allowed on init and still split on bootstrap", () => {
		expect(() =>
			assertNamedAgentTooling(["cursor", "vscode"]),
		).not.toThrow();
		expect(() =>
			assertNamedAgentTooling(["cursor", "vscode"], "init", {
				yes: true,
			}),
		).not.toThrow();
		expect(() =>
			assertNamedAgentTooling(["cursor", "vscode"], "bootstrap", {
				directory: "my-app",
				yes: true,
			}),
		).toThrow(
			/Re-run `neon bootstrap my-app --default --agent cursor` or `neon bootstrap my-app --default --agent vscode`/,
		);
		expect(() =>
			assertNamedAgentTooling(["cursor", "vscode"], "bootstrap", {
				directory: "my app",
				yes: true,
			}),
		).toThrow(
			/Re-run `neon bootstrap "my app" --default --agent cursor` or `neon bootstrap "my app" --default --agent vscode`/,
		);
	});

	test("empty list is a no-op", () => {
		expect(() => assertNamedAgentTooling([])).not.toThrow();
	});
});

describe("planYesAgentSteps", () => {
	test("plugin is plugins -y", () => {
		expect(
			planYesAgentSteps({
				setup: "plugin",
				agents: ["cursor", "codex"],
			}),
		).toEqual([{ kind: "plugins", options: { yes: true } }]);
	});

	test("skills-mcp omits an empty step; MCP is global mcp -y", () => {
		expect(
			planYesAgentSteps({
				setup: "skills-mcp",
				skillsAgents: [],
				mcpAgents: ["vscode"],
			}),
		).toEqual([{ kind: "mcp", options: { yes: true } }]);
		expect(
			planYesAgentSteps({
				setup: "skills-mcp",
				skillsAgents: ["vscode"],
				mcpAgents: ["vscode"],
			}),
		).toEqual([
			{ kind: "skills", options: { yes: true } },
			{ kind: "mcp", options: { yes: true } },
		]);
	});

	test("skip is empty", () => {
		expect(planYesAgentSteps({ setup: "skip" })).toEqual([]);
	});
});

describe("planToolingSteps", () => {
	test("named -y plugin forwards --agent", () => {
		expect(
			planToolingSteps(
				{ setup: "plugin", agents: ["cursor", "claude-code"] },
				{ yes: true, named: true },
			),
		).toEqual([
			{
				kind: "plugins",
				options: { yes: true, agents: ["cursor", "claude-code"] },
			},
		]);
	});

	test("named interactive skills-mcp forwards without -y", () => {
		expect(
			planToolingSteps(
				{
					setup: "skills-mcp",
					skillsAgents: ["vscode"],
					mcpAgents: ["vscode"],
				},
				{ yes: false, named: true },
			),
		).toEqual([
			{ kind: "skills", options: { yes: false, agents: ["vscode"] } },
			{ kind: "mcp", options: { yes: false, agents: ["vscode"] } },
		]);
	});
});

describe("resolveNamedAgents", () => {
	test("resolves aliases and dedupes", () => {
		expect(resolveNamedAgents(["claude", "cursor", "claude-code"])).toEqual(
			["claude-code", "cursor"],
		);
	});

	test("empty is empty", () => {
		expect(resolveNamedAgents([])).toEqual([]);
	});

	test("unknown agent names supported agents", () => {
		expect(() => resolveNamedAgents(["not-an-agent"])).toThrow(
			/Unknown agent: "not-an-agent"/,
		);
	});

	test("rejects *", () => {
		expect(() => resolveNamedAgents(["*"])).toThrow(/--agent \*/);
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
