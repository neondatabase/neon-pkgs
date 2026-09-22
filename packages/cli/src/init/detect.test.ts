import { describe, expect, test } from "vitest";
import { collectDetectedAgents } from "./detect.js";
import {
	initEndProperties,
	initFlagsFromArgv,
	initStartProperties,
} from "./funnel.js";
import {
	FALLBACK_SKILLS_AGENTS,
	planInitToolingSteps,
	recommendedTooling,
	splitInitTooling,
} from "./plan.js";

describe("collectDetectedAgents", () => {
	test("unions global, project, and host, and dedupes", () => {
		expect(
			collectDetectedAgents({
				host: "cursor",
				project: ["claude-code", "cursor"],
				global: ["codex", "claude-code"],
			}),
		).toEqual(["codex", "claude-code", "cursor"]);
	});
});

describe("splitInitTooling", () => {
	test("plugin-capable agents stay on the plugin", () => {
		expect(splitInitTooling(["cursor", "claude-code"], "global")).toEqual({
			setup: "plugin",
			agents: ["cursor", "claude-code"],
		});
	});

	test("mixed plugin and MCP-only agents install both mechanisms", () => {
		const split = splitInitTooling(["cursor", "opencode"], "global");
		expect(split.setup).toBe("mixed");
		if (split.setup !== "mixed") {
			return;
		}
		expect(split.pluginAgents).toEqual(["cursor"]);
		expect(split.skillsAgents).toContain("opencode");
	});

	test("vscode is plugin-capable at user scope", () => {
		expect(splitInitTooling(["vscode"], "global")).toEqual({
			setup: "plugin",
			agents: ["vscode"],
		});
	});
});

describe("recommendedTooling", () => {
	test("empty detection falls back to Cursor and Codex skills", () => {
		expect(recommendedTooling([])).toEqual({
			setup: "skills",
			agents: FALLBACK_SKILLS_AGENTS,
		});
	});
});

describe("planInitToolingSteps", () => {
	test("recommended plugin install is global and names every agent", () => {
		expect(
			planInitToolingSteps({
				tooling: { setup: "plugin", agents: ["cursor", "codex"] },
				yes: true,
				pluginScope: "global",
				skillsGlobal: true,
				mcpOauth: true,
			}),
		).toEqual([
			[
				"plugins",
				"--global",
				"-y",
				"--agent",
				"cursor",
				"--agent",
				"codex",
			],
		]);
	});

	test("empty-union skills fallback is global and does not configure MCP", () => {
		expect(
			planInitToolingSteps({
				tooling: { setup: "skills", agents: FALLBACK_SKILLS_AGENTS },
				yes: true,
				pluginScope: "global",
				skillsGlobal: true,
				mcpOauth: true,
			}),
		).toEqual([
			[
				"skills",
				"--global",
				"-y",
				"--agent",
				"cursor",
				"--agent",
				"codex",
			],
		]);
	});
});

describe("initFlagsFromArgv", () => {
	test("normalizes aliases and ignores values", () => {
		expect(
			initFlagsFromArgv([
				"node",
				"neon",
				"init",
				"-y",
				"--agent",
				"cursor",
				"--no-link",
			]),
		).toEqual(["--yes", "--agent", "--no-link"]);
	});
});

describe("init funnel payloads", () => {
	test("start records detection, not secrets", () => {
		const start = initStartProperties({
			initRunId: "run-1",
			argv: ["init", "-y"],
			detection: {
				authenticated: false,
				emptyDirectory: true,
				interactive: false,
				hostAgent: null,
				detectedAgents: [],
				ci: true,
			},
		});
		expect(start.init_run_id).toBe("run-1");
		expect(start.flags).toEqual(["--yes"]);
		expect(start.authenticated).toBe(false);
		expect(JSON.stringify(start)).not.toMatch(/api[-_]?key/i);
	});

	test("end uses null for choices that were not reached", () => {
		const end = initEndProperties({
			initRunId: "run-1",
			mode: null,
			agentSetup: null,
			agentsInstalled: [],
			link: null,
			config: null,
			services: null,
			outcome: "aborted",
		});
		expect(end.mode).toBeNull();
		expect(end.agent_setup).toBeNull();
		expect(end.outcome).toBe("aborted");
	});
});
