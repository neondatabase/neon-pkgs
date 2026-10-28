import { describe, expect, test } from "vitest";
import { NeonApiError } from "../api.js";
import { AuthRefreshError } from "../auth.js";
import { collectDetectedAgents } from "./detect.js";
import {
	initEndProperties,
	initErrorCode,
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

	test("agents whose plugin command is missing get skills and MCP", () => {
		expect(
			splitInitTooling(
				["cursor", "github-copilot-cli", "grok-build"],
				"global",
				"global",
				["github-copilot-cli", "grok-build"],
			),
		).toEqual({
			setup: "mixed",
			pluginAgents: ["cursor"],
			skillsAgents: ["github-copilot-cli", "grok-build"],
			mcpAgents: ["github-copilot-cli", "grok-build"],
		});
	});

	test("Copilot CLI and Grok stay on the plugin when their commands exist", () => {
		expect(
			splitInitTooling(["github-copilot-cli", "grok-build"], "global"),
		).toEqual({
			setup: "plugin",
			agents: ["github-copilot-cli", "grok-build"],
		});
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

	test("only command-less plugin agents get skills and MCP", () => {
		expect(
			recommendedTooling(["github-copilot-cli"], ["github-copilot-cli"]),
		).toEqual({
			setup: "skills-mcp",
			skillsAgents: ["github-copilot-cli"],
			mcpAgents: ["github-copilot-cli"],
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
			{
				kind: "plugins",
				options: {
					yes: true,
					global: true,
					agents: ["cursor", "codex"],
				},
			},
		]);
	});

	test("empty-union skills fallback is this directory and does not configure MCP", () => {
		expect(
			planInitToolingSteps({
				tooling: { setup: "skills", agents: FALLBACK_SKILLS_AGENTS },
				yes: true,
				pluginScope: "global",
				skillsGlobal: true,
				mcpOauth: true,
			}),
		).toEqual([
			{
				kind: "skills",
				options: { yes: true, agents: ["cursor", "codex"] },
			},
		]);
	});

	test("oauth MCP includes --project-id when pinned", () => {
		expect(
			planInitToolingSteps({
				tooling: {
					setup: "skills-mcp",
					skillsAgents: ["opencode"],
					mcpAgents: ["opencode"],
				},
				yes: true,
				pluginScope: "project",
				skillsGlobal: false,
				mcpOauth: true,
				mcpProjectId: "proj-pin",
			}),
		).toEqual([
			{
				kind: "skills",
				options: { yes: true, global: false, agents: ["opencode"] },
			},
			{
				kind: "mcp",
				options: {
					yes: true,
					oauth: true,
					project: false,
					projectId: "proj-pin",
					agent: ["opencode"],
				},
			},
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
			errors: [],
		});
		expect(end.mode).toBeNull();
		expect(end.agent_setup).toBeNull();
		expect(end.outcome).toBe("aborted");
		expect(end.error_step).toBeNull();
		expect(end.error_code).toBeNull();
		expect(end.error_message).toBeNull();
		expect(end.error_steps).toEqual([]);
	});

	test("end reports the failure the run exited with", () => {
		const exit = new Error("env pull failed");
		const end = initEndProperties({
			initRunId: "run-1",
			mode: "recommended",
			agentSetup: "plugin",
			agentsInstalled: [],
			link: "linked",
			config: "created",
			services: ["postgres"],
			outcome: "error",
			errors: [
				{ step: "plugins", error: new Error("plugins CLI failed.") },
				{ step: "env_pull", error: exit },
			],
			exitError: exit,
		});
		expect(end.error_step).toBe("env_pull");
		expect(end.error_message).toBe("env pull failed");
		expect(end.error_steps).toEqual(["plugins", "env_pull"]);
	});

	test("end reports the first failure when none ended the run, and every failed step", () => {
		const plugins = new Error(
			"\u001b[31mplugins CLI timed out after 120 seconds.\u001b[39m nak_live_0123abcd",
		);
		const end = initEndProperties({
			initRunId: "run-1",
			mode: "recommended",
			agentSetup: "plugin",
			agentsInstalled: [],
			link: "linked",
			config: "created",
			services: ["postgres"],
			outcome: "error",
			errors: [
				{ step: "plugins", error: plugins },
				{ step: "env_pull", error: new Error("env pull failed") },
				{ step: "plugins", error: new Error("second plugins failure") },
			],
		});
		expect(end.error_step).toBe("plugins");
		expect(end.error_code).toBe("UNKNOWN_ERROR");
		expect(end.error_message).toBe(
			"plugins CLI timed out after 120 seconds. nak_live_<redacted>",
		);
		expect(end.error_steps).toEqual(["plugins", "env_pull"]);
	});

	test("end caps the error message", () => {
		const end = initEndProperties({
			initRunId: "run-1",
			mode: null,
			agentSetup: null,
			agentsInstalled: [],
			link: null,
			config: null,
			services: null,
			outcome: "error",
			errors: [{ step: "setup", error: new Error("x".repeat(5_000)) }],
		});
		expect(end.error_message).toHaveLength(2_000);
	});
});

describe("initErrorCode", () => {
	test.each([
		["a plain error", new Error("plugins CLI failed."), "UNKNOWN_ERROR"],
		[
			"init's own failure",
			new Error("Setup did not finish."),
			"NEON_INIT_FAILED",
		],
		[
			"a connection failure",
			Object.assign(new TypeError("fetch failed"), {
				cause: { code: "ENOTFOUND" },
			}),
			"NETWORK_ERROR",
		],
		[
			"an expired session",
			new AuthRefreshError("expired", { terminal: true }),
			"AUTH_FAILED",
		],
		["a 404", new NeonApiError("not found", { status: 404 }), "API_ERROR"],
		[
			"a 401",
			new NeonApiError("unauthorized", { status: 401 }),
			"AUTH_FAILED",
		],
		[
			"an SSO denial masked as 404",
			new NeonApiError("not found", {
				status: 404,
				data: { code: "SSO_AUTHORIZATION_REQUIRED" },
			}),
			"AUTH_FAILED",
		],
		[
			"a request timeout",
			new NeonApiError("timeout", { code: "ECONNABORTED" }),
			"REQUEST_TIMEOUT",
		],
	])("classifies %s like the top-level handler", (_label, error, code) => {
		expect(initErrorCode(error)).toBe(code);
	});
});
