import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordCredentialInputs } from "@neon-internals/cli-core/auth_selection";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { InitAgentSetup } from "../init/plan.js";
import { test as cliTest } from "../test_utils/fixtures.js";

vi.mock("../analytics.js", () => ({
	sendError: vi.fn(),
	trackEvent: vi.fn(),
	closeAnalytics: vi.fn(),
}));

const host = "https://console.neon.tech/api/v2";

const baseProps = (overrides: Record<string, unknown> = {}) => ({
	apiClient: {} as never,
	apiKey: "test-key",
	apiHost: host,
	output: "table" as const,
	contextFile: "/tmp/does-not-exist/.neon",
	...overrides,
});

const clearCredentialInputs = () =>
	recordCredentialInputs({
		apiKeyFlag: "",
		apiKeyEnv: "",
		profileEnv: "",
		profileFlag: "",
		configDir: "",
	});

const pickSkillsMcp = async (): Promise<InitAgentSetup> => "skills-mcp";

describe("init handler", () => {
	beforeEach(() => {
		vi.stubEnv("CI", "true");
	});

	afterEach(() => {
		clearCredentialInputs();
		vi.unstubAllEnvs();
		vi.restoreAllMocks();
		vi.resetModules();
	});

	test("empty directory without -y fails before bootstrap", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "neon-init-empty-"));
		const run = vi.fn().mockResolvedValue(true);
		const { handler } = await import("./init.js");

		await expect(
			handler(
				baseProps({
					cwd,
					run,
					contextFile: join(cwd, ".neon"),
				}),
			),
		).rejects.toThrow(/Pass -y to use defaults/);
		expect(run).not.toHaveBeenCalled();
	});

	test("existing app without -y fails before children", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "neon-init-ci-"));
		writeFileSync(join(cwd, "package.json"), "{}\n");
		const run = vi.fn().mockResolvedValue(true);
		const { handler } = await import("./init.js");

		await expect(
			handler(
				baseProps({
					cwd,
					run,
					contextFile: join(cwd, ".neon"),
				}),
			),
		).rejects.toThrow(/Pass -y to use defaults/);
		expect(run).not.toHaveBeenCalled();
	});

	test("existing app with --agent skips the picker without -y", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "neon-init-named-"));
		writeFileSync(join(cwd, "package.json"), "{}\n");
		const run = vi.fn().mockResolvedValue(true);
		const pickAgentSetup = vi.fn(pickSkillsMcp);
		const detectAgent = vi.fn(() => "vscode");
		const { handler } = await import("./init.js");

		await handler(
			baseProps({
				cwd,
				run,
				contextFile: join(cwd, ".neon"),
				agent: ["cursor", "claude-code"],
				pickAgentSetup,
				detectAgent,
			}),
		);

		expect(pickAgentSetup).not.toHaveBeenCalled();
		expect(detectAgent).not.toHaveBeenCalled();
		expect(run.mock.calls[0][0]).toEqual(
			expect.arrayContaining([
				"plugins",
				"--agent",
				"cursor",
				"--agent",
				"claude-code",
			]),
		);
		expect(run.mock.calls[0][0]).not.toContain("-y");
		expect(run.mock.calls.map((call) => call[0][0])).toEqual([
			"plugins",
			"link",
			"config",
		]);
	});

	test("existing app runs skills, mcp, link, config init", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "neon-init-app-"));
		writeFileSync(join(cwd, "package.json"), "{}\n");
		const run = vi.fn().mockResolvedValue(true);
		const { handler } = await import("./init.js");

		await handler(
			baseProps({
				cwd,
				run,
				contextFile: join(cwd, ".neon"),
				pickAgentSetup: pickSkillsMcp,
			}),
		);

		expect(run.mock.calls.map((call) => call[0][0])).toEqual([
			"skills",
			"mcp",
			"link",
			"config",
		]);
		expect(run.mock.calls[3][0].slice(0, 2)).toEqual(["config", "init"]);
	});

	test("linked app skips link", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "neon-init-linked-"));
		writeFileSync(join(cwd, "package.json"), "{}\n");
		const contextFile = join(cwd, ".neon");
		writeFileSync(
			contextFile,
			`${JSON.stringify({ projectId: "proj-1" })}\n`,
		);
		const run = vi.fn().mockResolvedValue(true);
		const { handler } = await import("./init.js");

		await handler(
			baseProps({ cwd, run, contextFile, pickAgentSetup: pickSkillsMcp }),
		);

		expect(run.mock.calls.map((call) => call[0][0])).toEqual([
			"skills",
			"mcp",
			"config",
		]);
	});

	test("empty -y runs only bootstrap . --default", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "neon-init-empty-y-"));
		const run = vi.fn().mockResolvedValue(true);
		const { handler } = await import("./init.js");

		await handler(
			baseProps({
				cwd,
				run,
				yes: true,
				contextFile: join(cwd, ".neon"),
			}),
		);

		expect(run.mock.calls[0][0].slice(0, 3)).toEqual([
			"bootstrap",
			".",
			"--default",
		]);
		expect(run).toHaveBeenCalledTimes(1);
	});

	test("stops on the first failed step", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "neon-init-fail-"));
		writeFileSync(join(cwd, "package.json"), "{}\n");
		const run = vi
			.fn()
			.mockResolvedValueOnce(false)
			.mockResolvedValue(true);
		const { handler } = await import("./init.js");

		await expect(
			handler(
				baseProps({
					cwd,
					run,
					contextFile: join(cwd, ".neon"),
					pickAgentSetup: pickSkillsMcp,
				}),
			),
		).rejects.toThrow("`neon skills` failed.");
		expect(run).toHaveBeenCalledTimes(1);
	});

	test("forwards profile, config-dir, context-file, and --no-analytics", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "neon-init-fwd-"));
		mkdirSync(join(cwd, "src"));
		const contextFile = join(cwd, ".neon");
		writeFileSync(
			contextFile,
			`${JSON.stringify({ projectId: "proj-1" })}\n`,
		);
		const run = vi.fn().mockResolvedValue(true);
		const { handler } = await import("./init.js");

		await handler(
			baseProps({
				cwd,
				run,
				contextFile,
				configDir: "/cfg",
				profile: "work",
				analytics: false,
				pickAgentSetup: pickSkillsMcp,
			}),
		);

		expect(run.mock.calls[0][0]).toEqual([
			"skills",
			"--config-dir",
			"/cfg",
			"--profile",
			"work",
			"--api-host",
			host,
			"--context-file",
			contextFile,
			"--no-analytics",
		]);
		expect(run.mock.calls[0][1]).toBe(cwd);
	});

	test("empty -y passes NEON_API_KEY to bootstrap", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "neon-init-key-"));
		const { recordCredentialInputs: record } = await import(
			"@neon-internals/cli-core/auth_selection"
		);
		record({
			apiKeyFlag: "napi_test",
			apiKeyEnv: "",
			profileEnv: "",
			profileFlag: "",
			configDir: "",
		});
		const run = vi.fn().mockResolvedValue(true);
		const { handler } = await import("./init.js");

		await handler(
			baseProps({
				cwd,
				run,
				yes: true,
				contextFile: join(cwd, ".neon"),
			}),
		);

		expect(run.mock.calls.map((call) => [call[0][0], call[2]])).toEqual([
			["bootstrap", { NEON_API_KEY: "napi_test" }],
		]);
	});

	test("existing -y passes NEON_API_KEY only to mcp and link", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "neon-init-key-app-"));
		writeFileSync(join(cwd, "package.json"), "{}\n");
		mkdirSync(join(cwd, ".vscode"));
		const { recordCredentialInputs: record } = await import(
			"@neon-internals/cli-core/auth_selection"
		);
		record({
			apiKeyFlag: "napi_test",
			apiKeyEnv: "",
			profileEnv: "",
			profileFlag: "",
			configDir: "",
		});
		const run = vi.fn().mockResolvedValue(true);
		const { handler } = await import("./init.js");

		await handler(
			baseProps({
				cwd,
				run,
				yes: true,
				contextFile: join(cwd, ".neon"),
			}),
		);

		expect(run.mock.calls.map((call) => [call[0][0], call[2]])).toEqual([
			["skills", undefined],
			["mcp", { NEON_API_KEY: "napi_test" }],
			["link", { NEON_API_KEY: "napi_test" }],
			["config", undefined],
		]);
	});

	test("parent .neon with a projectId skips link", async () => {
		const root = mkdtempSync(join(tmpdir(), "neon-init-parent-"));
		writeFileSync(
			join(root, ".neon"),
			`${JSON.stringify({ projectId: "proj-parent" })}\n`,
		);
		const cwd = join(root, "app");
		mkdirSync(cwd);
		writeFileSync(join(cwd, "package.json"), "{}\n");
		const run = vi.fn().mockResolvedValue(true);
		const { handler } = await import("./init.js");

		await handler(
			baseProps({
				cwd,
				run,
				contextFile: join(root, ".neon"),
				pickAgentSetup: pickSkillsMcp,
			}),
		);

		expect(run.mock.calls.map((call) => call[0][0])).toEqual([
			"skills",
			"mcp",
			"config",
		]);
	});

	test("a .neon without projectId is not linked", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "neon-init-empty-ctx-"));
		writeFileSync(join(cwd, "package.json"), "{}\n");
		const contextFile = join(cwd, ".neon");
		writeFileSync(contextFile, "{}\n");
		const run = vi.fn().mockResolvedValue(true);
		const { handler } = await import("./init.js");

		await handler(
			baseProps({ cwd, run, contextFile, pickAgentSetup: pickSkillsMcp }),
		);

		expect(run.mock.calls.map((call) => call[0][0])).toEqual([
			"skills",
			"mcp",
			"link",
			"config",
		]);
	});

	test("resolves a relative context file against cwd", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "neon-init-rel-ctx-"));
		writeFileSync(join(cwd, "package.json"), "{}\n");
		writeFileSync(
			join(cwd, ".neon"),
			`${JSON.stringify({ projectId: "proj-rel" })}\n`,
		);
		const run = vi.fn().mockResolvedValue(true);
		const { handler } = await import("./init.js");

		await handler(
			baseProps({
				cwd,
				run,
				contextFile: ".neon",
				pickAgentSetup: pickSkillsMcp,
			}),
		);

		expect(run.mock.calls.map((call) => call[0][0])).toEqual([
			"skills",
			"mcp",
			"config",
		]);
		expect(run.mock.calls[0][0]).toEqual(
			expect.arrayContaining(["--context-file", join(cwd, ".neon")]),
		);
	});

	test("refuses --output json and yaml", async () => {
		const { handler } = await import("./init.js");
		await expect(handler(baseProps({ output: "json" }))).rejects.toThrow(
			"does not support --output",
		);
		await expect(handler(baseProps({ output: "yaml" }))).rejects.toThrow(
			"does not support --output",
		);
	});

	test("interactive plugin: plugins then link and config init", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "neon-init-pick-plugin-"));
		writeFileSync(join(cwd, "package.json"), "{}\n");
		const run = vi.fn().mockResolvedValue(true);
		const { handler } = await import("./init.js");

		await handler(
			baseProps({
				cwd,
				run,
				contextFile: join(cwd, ".neon"),
				pickAgentSetup: async () => "plugin",
			}),
		);

		expect(run.mock.calls.map((call) => call[0][0])).toEqual([
			"plugins",
			"link",
			"config",
		]);
	});

	test("interactive skip: link and config init", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "neon-init-pick-skip-"));
		writeFileSync(join(cwd, "package.json"), "{}\n");
		const run = vi.fn().mockResolvedValue(true);
		const { handler } = await import("./init.js");

		await handler(
			baseProps({
				cwd,
				run,
				contextFile: join(cwd, ".neon"),
				pickAgentSetup: async () => "skip",
			}),
		);

		expect(run.mock.calls.map((call) => call[0][0])).toEqual([
			"link",
			"config",
		]);
	});

	test("-y with .cursor installs the plugin, not skills and mcp", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "neon-init-y-cursor-"));
		mkdirSync(join(cwd, ".cursor"));
		const run = vi.fn().mockResolvedValue(true);
		const { handler } = await import("./init.js");

		await handler(
			baseProps({
				cwd,
				run,
				yes: true,
				contextFile: join(cwd, ".neon"),
			}),
		);

		expect(run.mock.calls.map((call) => call[0][0])).toEqual([
			"plugins",
			"link",
			"config",
		]);
		expect(run.mock.calls[0][0].slice(0, 2)).toEqual(["plugins", "-y"]);
		expect(run.mock.calls[2][0].slice(0, 4)).toEqual([
			"config",
			"init",
			"--services",
			"none",
		]);
	});

	test("-y with only .vscode keeps skills and mcp", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "neon-init-y-vscode-"));
		mkdirSync(join(cwd, ".vscode"));
		writeFileSync(join(cwd, "package.json"), "{}\n");
		const run = vi.fn().mockResolvedValue(true);
		const { handler } = await import("./init.js");

		await handler(
			baseProps({
				cwd,
				run,
				yes: true,
				contextFile: join(cwd, ".neon"),
			}),
		);

		expect(run.mock.calls.map((call) => call[0][0])).toEqual([
			"skills",
			"mcp",
			"link",
			"config",
		]);
		expect(run.mock.calls[0][0].slice(0, 2)).toEqual(["skills", "-y"]);
		expect(run.mock.calls[0][0]).not.toContain("--agent");
		expect(run.mock.calls[1][0].slice(0, 2)).toEqual(["mcp", "-y"]);
		expect(run.mock.calls[1][0]).not.toContain("--project");
		expect(run.mock.calls[1][0]).not.toContain("--agent");
	});

	test("-y --agent skips detection and forwards names", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "neon-init-y-named-"));
		mkdirSync(join(cwd, ".cursor"));
		writeFileSync(join(cwd, "package.json"), "{}\n");
		const run = vi.fn().mockResolvedValue(true);
		const detectProjectAgents = vi.fn(() => ["cursor"]);
		const detectAgent = vi.fn(() => "cursor");
		const { handler } = await import("./init.js");

		await handler(
			baseProps({
				cwd,
				run,
				yes: true,
				agent: ["vscode"],
				contextFile: join(cwd, ".neon"),
				detectProjectAgents,
				detectAgent,
			}),
		);

		expect(detectProjectAgents).not.toHaveBeenCalled();
		expect(detectAgent).not.toHaveBeenCalled();
		expect(run.mock.calls.map((call) => call[0][0])).toEqual([
			"skills",
			"mcp",
			"link",
			"config",
		]);
		expect(run.mock.calls[0][0]).toEqual(
			expect.arrayContaining(["skills", "-y", "--agent", "vscode"]),
		);
		expect(run.mock.calls[1][0]).toEqual(
			expect.arrayContaining(["mcp", "-y", "--agent", "vscode"]),
		);
		expect(run.mock.calls[1][0]).not.toContain("--project");
	});

	test("empty -y forwards --agent to bootstrap", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "neon-init-empty-agent-"));
		const run = vi.fn().mockResolvedValue(true);
		const { handler } = await import("./init.js");

		await handler(
			baseProps({
				cwd,
				run,
				yes: true,
				agent: ["cursor"],
				contextFile: join(cwd, ".neon"),
			}),
		);

		expect(run.mock.calls[0][0]).toEqual(
			expect.arrayContaining([
				"bootstrap",
				".",
				"--default",
				"--agent",
				"cursor",
			]),
		);
		expect(run).toHaveBeenCalledTimes(1);
	});

	test("empty dir mixed --agent fails before bootstrap", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "neon-init-empty-mixed-"));
		const run = vi.fn().mockResolvedValue(true);
		const { handler } = await import("./init.js");

		await expect(
			handler(
				baseProps({
					cwd,
					run,
					yes: true,
					agent: ["cursor", "vscode"],
					contextFile: join(cwd, ".neon"),
				}),
			),
		).rejects.toThrow(/plugin and skills\/MCP/);
		expect(run).not.toHaveBeenCalled();
	});

	test("named --agent cursor and vscode fails instead of dropping vscode", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "neon-init-mixed-"));
		writeFileSync(join(cwd, "package.json"), "{}\n");
		const run = vi.fn().mockResolvedValue(true);
		const { handler } = await import("./init.js");

		await expect(
			handler(
				baseProps({
					cwd,
					run,
					yes: true,
					agent: ["cursor", "vscode"],
					contextFile: join(cwd, ".neon"),
				}),
			),
		).rejects.toThrow(/plugin and skills\/MCP/);
		expect(run).not.toHaveBeenCalled();
	});

	test("unknown --agent fails before children", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "neon-init-bad-agent-"));
		writeFileSync(join(cwd, "package.json"), "{}\n");
		const run = vi.fn().mockResolvedValue(true);
		const { handler } = await import("./init.js");

		await expect(
			handler(
				baseProps({
					cwd,
					run,
					yes: true,
					agent: ["not-an-agent"],
					contextFile: join(cwd, ".neon"),
				}),
			),
		).rejects.toThrow(/Unknown agent: "not-an-agent"/);
		expect(run).not.toHaveBeenCalled();
	});

	test("-y with no detected agents fails before link", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "neon-init-y-skip-"));
		writeFileSync(join(cwd, "package.json"), "{}\n");
		const run = vi.fn().mockResolvedValue(true);
		const detectProjectAgents = vi.fn(() => []);
		const detectAgent = vi.fn(() => null);
		const { handler } = await import("./init.js");

		await expect(
			handler(
				baseProps({
					cwd,
					run,
					yes: true,
					contextFile: join(cwd, ".neon"),
					detectProjectAgents,
					detectAgent,
				}),
			),
		).rejects.toThrow(/No coding agents detected in this project/);
		expect(detectProjectAgents).toHaveBeenCalled();
		expect(detectAgent).toHaveBeenCalled();
		expect(run).not.toHaveBeenCalled();
	});

	test("empty -y does not detect agents in the parent", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "neon-init-y-empty-detect-"));
		const run = vi.fn().mockResolvedValue(true);
		const detectProjectAgents = vi.fn(() => ["cursor"]);
		const detectAgent = vi.fn(() => "cursor");
		const { handler } = await import("./init.js");

		await handler(
			baseProps({
				cwd,
				run,
				yes: true,
				contextFile: join(cwd, ".neon"),
				detectProjectAgents,
				detectAgent,
			}),
		);

		expect(detectProjectAgents).not.toHaveBeenCalled();
		expect(detectAgent).not.toHaveBeenCalled();
		expect(run).toHaveBeenCalledTimes(1);
		expect(run.mock.calls[0][0].slice(0, 3)).toEqual([
			"bootstrap",
			".",
			"--default",
		]);
	});

	test("strips an ambient NEON_API_KEY from skills and plugins, not bootstrap, link, or mcp", async () => {
		const { initChildEnv } = await import("./init.js");
		const base = { PATH: "/bin", NEON_API_KEY: "napi_env" };
		expect(initChildEnv("bootstrap", undefined, base)).toEqual(base);
		expect(initChildEnv("plugins", undefined, base)).toEqual({
			PATH: "/bin",
		});
		expect(initChildEnv("skills", undefined, base)).toEqual({
			PATH: "/bin",
		});
		expect(initChildEnv("link", undefined, base)).toEqual(base);
		expect(
			initChildEnv("mcp", { NEON_API_KEY: "napi_flag" }, base),
		).toEqual({
			PATH: "/bin",
			NEON_API_KEY: "napi_flag",
		});
		expect(
			initChildEnv("skills", undefined, {
				PATH: "/bin",
				neon_api_key: "napi_mixed",
			}),
		).toEqual({ PATH: "/bin" });
	});

	test("does not pass NEON_API_KEY to plugins", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "neon-init-plugin-key-"));
		mkdirSync(join(cwd, ".cursor"));
		const { recordCredentialInputs: record } = await import(
			"@neon-internals/cli-core/auth_selection"
		);
		record({
			apiKeyFlag: "napi_test",
			apiKeyEnv: "",
			profileEnv: "",
			profileFlag: "",
			configDir: "",
		});
		const run = vi.fn().mockResolvedValue(true);
		const { handler } = await import("./init.js");

		await handler(
			baseProps({
				cwd,
				run,
				yes: true,
				contextFile: join(cwd, ".neon"),
			}),
		);

		expect(run.mock.calls.map((call) => [call[0][0], call[2]])).toEqual([
			["plugins", undefined],
			["link", { NEON_API_KEY: "napi_test" }],
			["config", undefined],
		]);
	});
});

describe("init CLI", () => {
	cliTest("help describes the orchestrator", async ({ testCliCommand }) => {
		const { stdout, stderr } = await testCliCommand(["init", "--help"], {
			snapshot: false,
		});
		const help = `${stdout}\n${stderr}`;
		expect(help).toMatch(/scaffold/i);
		expect(help).toMatch(/plugin/i);
		expect(help).toMatch(/skip agent setup/i);
		expect(help).toMatch(/Cursor, Claude Code, or Codex/);
		expect(help).toMatch(/host CLI agent/);
		expect(help).toMatch(/exits/);
		expect(help).toMatch(/-a, --agent/);
		expect(help).toMatch(/Skip agent selection/);
		expect(help.replace(/\s+/g, " ")).toMatch(
			/passed to plugins\s*,\s*skills, and mcp/i,
		);
		expect(help).not.toMatch(/installed apps/);
		expect(help).not.toMatch(/Set output format/);
	});

	cliTest("rejects --data", async ({ testCliCommand }) => {
		await testCliCommand(["init", "--data", '{"step":"auth"}'], {
			snapshot: false,
			code: 1,
			stderr: expect.stringContaining("was removed"),
		});
	});

	cliTest("rejects --output json", async ({ testCliCommand }) => {
		await testCliCommand(["init"], {
			snapshot: false,
			output: "json",
			code: 1,
			stderr: expect.stringContaining("does not support --output"),
		});
	});

	cliTest("rejects --agent without a value", async ({ testCliCommand }) => {
		const { stderr } = await testCliCommand(["init", "--agent"], {
			snapshot: false,
			code: 1,
		});
		expect(stderr).toMatch(/--agent needs a value/);
	});

	cliTest("rejects an unknown --agent", async ({ testCliCommand }) => {
		const { stderr } = await testCliCommand(
			["init", "-y", "--agent", "not-an-agent"],
			{ snapshot: false, code: 1, outputTable: true },
		);
		expect(stderr).toMatch(/Unknown agent: "not-an-agent"/);
		expect(stderr).not.toMatch(/Unknown argument: agent/);
	});
});
