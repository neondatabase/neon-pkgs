import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordCredentialInputs } from "@neon-internals/cli-core/auth_selection";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import yargs from "yargs";
import type { BootstrapTemplate } from "../init/bootstrap.js";
import type { InitAgentSetup } from "../init/plan.js";
import { test as cliTest } from "../test_utils/fixtures.js";
import { builder } from "./init.js";

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

const nestedBootstrapOk = (overrides: Record<string, unknown> = {}) =>
	vi.fn().mockResolvedValue({
		templateTitle: "Hono API",
		targetDir: "/tmp",
		hasNeonConfig: true,
		installed: true,
		installFailed: false,
		gitFailed: false,
		git: true,
		linked: true,
		skippedLinkForDeps: false,
		agentSetup: "skills-mcp",
		agentsRan: true,
		...overrides,
	});

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
		const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
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
		const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
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
		const out = stdout.mock.calls.map((call) => String(call[0])).join("");
		expect(out).toContain("Neon setup complete.");
		expect(out).not.toContain("INFO:");
		expect(out).not.toContain("██████╗");
		expect(out).not.toContain("See the README");
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

	test("empty -y runs nested bootstrap --default", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "neon-init-empty-y-"));
		const run = vi.fn().mockResolvedValue(true);
		const runBootstrap = nestedBootstrapOk();
		const { handler } = await import("./init.js");

		await handler(
			baseProps({
				cwd,
				run,
				yes: true,
				contextFile: join(cwd, ".neon"),
				runBootstrap,
			}),
		);

		expect(run).not.toHaveBeenCalled();
		expect(runBootstrap).toHaveBeenCalledTimes(1);
		expect(runBootstrap.mock.calls[0][0]).toMatchObject({
			default: true,
			printBanner: false,
			skipDoneSummary: true,
			linkNoConfig: true,
			directory: cwd,
		});
		expect(runBootstrap.mock.calls[0][0].template).toBeUndefined();
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

	test("empty -y forwards run into nested bootstrap", async () => {
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
		const runBootstrap = nestedBootstrapOk();
		const { handler } = await import("./init.js");

		await handler(
			baseProps({
				cwd,
				run,
				yes: true,
				contextFile: join(cwd, ".neon"),
				runBootstrap,
			}),
		);

		expect(runBootstrap.mock.calls[0][0].run).toBe(run);
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

	test("empty -y forwards --agent to nested bootstrap", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "neon-init-empty-agent-"));
		const run = vi.fn().mockResolvedValue(true);
		const runBootstrap = nestedBootstrapOk();
		const { handler } = await import("./init.js");

		await handler(
			baseProps({
				cwd,
				run,
				yes: true,
				agent: ["cursor"],
				contextFile: join(cwd, ".neon"),
				runBootstrap,
			}),
		);

		expect(runBootstrap.mock.calls[0][0].agent).toEqual(["cursor"]);
		expect(run).not.toHaveBeenCalled();
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
		).rejects.toThrow(
			/Re-run `neon init -y --agent cursor` or `neon init -y --agent vscode`/,
		);
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
		).rejects.toThrow(
			/Re-run `neon init -y --agent cursor` or `neon init -y --agent vscode`/,
		);
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
		const runBootstrap = nestedBootstrapOk();
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
				runBootstrap,
			}),
		);

		expect(detectProjectAgents).not.toHaveBeenCalled();
		expect(detectAgent).not.toHaveBeenCalled();
		expect(run).not.toHaveBeenCalled();
		expect(runBootstrap).toHaveBeenCalledTimes(1);
	});

	test("strips an ambient NEON_API_KEY from skills and plugins, not bootstrap, link, mcp, or env", async () => {
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
		expect(initChildEnv("env", undefined, base)).toEqual(base);
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

	test("child link always gets --no-config", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "neon-init-link-noconfig-"));
		writeFileSync(join(cwd, "package.json"), "{}\n");
		const run = vi.fn().mockResolvedValue(true);
		const { handler } = await import("./init.js");

		await handler(
			baseProps({
				cwd,
				run,
				yes: true,
				contextFile: join(cwd, ".neon"),
				detectProjectAgents: () => ["cursor"],
			}),
		);

		const linkArgv = run.mock.calls.find(
			(call) => call[0][0] === "link",
		)?.[0];
		expect(linkArgv).toEqual(
			expect.arrayContaining(["link", "--yes", "--no-config"]),
		);
	});

	test("declining neon.ts skips config init and does not write the file", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "neon-init-skip-config-"));
		writeFileSync(join(cwd, "package.json"), "{}\n");
		const run = vi.fn().mockResolvedValue(true);
		const { handler } = await import("./init.js");

		await handler(
			baseProps({
				cwd,
				run,
				contextFile: join(cwd, ".neon"),
				pickAgentSetup: async () => "skip",
				pickConfig: async () => false,
			}),
		);

		expect(run.mock.calls.map((call) => call[0][0])).toEqual(["link"]);
		expect(existsSync(join(cwd, "neon.ts"))).toBe(false);
	});

	test("--no-config skips config init even with -y", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "neon-init-no-config-"));
		writeFileSync(join(cwd, "package.json"), "{}\n");
		mkdirSync(join(cwd, ".cursor"));
		const run = vi.fn().mockResolvedValue(true);
		const { handler } = await import("./init.js");

		await handler(
			baseProps({
				cwd,
				run,
				yes: true,
				config: false,
				contextFile: join(cwd, ".neon"),
			}),
		);

		expect(run.mock.calls.map((call) => call[0][0])).toEqual([
			"plugins",
			"link",
		]);
	});

	test("--config without -y writes neon.ts without --services none", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "neon-init-config-flag-"));
		writeFileSync(join(cwd, "package.json"), "{}\n");
		const run = vi.fn().mockResolvedValue(true);
		const { handler } = await import("./init.js");

		await handler(
			baseProps({
				cwd,
				run,
				config: true,
				contextFile: join(cwd, ".neon"),
				pickAgentSetup: async () => "skip",
			}),
		);

		expect(run.mock.calls.map((call) => call[0].slice(0, 2))).toEqual([
			["link", "--no-config"],
			["config", "init"],
		]);
		expect(run.mock.calls[1][0]).not.toContain("--services");
	});

	test("--services implies neon.ts and skips the consent prompt", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "neon-init-services-"));
		writeFileSync(join(cwd, "package.json"), "{}\n");
		const run = vi.fn().mockResolvedValue(true);
		const pickConfig = vi.fn(async () => false);
		const { handler } = await import("./init.js");

		await handler(
			baseProps({
				cwd,
				run,
				services: ["auth"],
				contextFile: join(cwd, ".neon"),
				pickAgentSetup: async () => "skip",
				pickConfig,
			}),
		);

		expect(pickConfig).not.toHaveBeenCalled();
		expect(run.mock.calls[1][0].slice(0, 4)).toEqual([
			"config",
			"init",
			"--services",
			"auth",
		]);
	});

	test("--services none writes the starter policy", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "neon-init-services-none-"));
		writeFileSync(join(cwd, "package.json"), "{}\n");
		const run = vi.fn().mockResolvedValue(true);
		const pickConfig = vi.fn(async () => false);
		const { handler } = await import("./init.js");

		await handler(
			baseProps({
				cwd,
				run,
				services: ["none"],
				contextFile: join(cwd, ".neon"),
				pickAgentSetup: async () => "skip",
				pickConfig,
			}),
		);

		expect(pickConfig).not.toHaveBeenCalled();
		expect(run.mock.calls[1][0].slice(0, 4)).toEqual([
			"config",
			"init",
			"--services",
			"none",
		]);
	});

	test("--no-config and --services conflict before children", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "neon-init-conflict-"));
		writeFileSync(join(cwd, "package.json"), "{}\n");
		const run = vi.fn().mockResolvedValue(true);
		const { handler } = await import("./init.js");

		await expect(
			handler(
				baseProps({
					cwd,
					run,
					config: false,
					services: ["auth"],
					contextFile: join(cwd, ".neon"),
					pickAgentSetup: async () => "skip",
				}),
			),
		).rejects.toThrow(/--no-config cannot be combined with --services/);
		expect(run).not.toHaveBeenCalled();
	});

	test("--template in a non-empty directory fails before children", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "neon-init-template-full-"));
		writeFileSync(join(cwd, "package.json"), "{}\n");
		const run = vi.fn().mockResolvedValue(true);
		const runBootstrap = nestedBootstrapOk();
		const { handler } = await import("./init.js");

		await expect(
			handler(
				baseProps({
					cwd,
					run,
					template: "hono",
					contextFile: join(cwd, ".neon"),
					runBootstrap,
				}),
			),
		).rejects.toThrow(/only for an empty directory/);
		expect(run).not.toHaveBeenCalled();
		expect(runBootstrap).not.toHaveBeenCalled();
	});

	test("--skip-template and --template conflict", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "neon-init-both-template-"));
		const run = vi.fn().mockResolvedValue(true);
		const runBootstrap = nestedBootstrapOk();
		const { handler } = await import("./init.js");

		await expect(
			handler(
				baseProps({
					cwd,
					run,
					skipTemplate: true,
					template: "hono",
					contextFile: join(cwd, ".neon"),
					runBootstrap,
				}),
			),
		).rejects.toThrow(/--skip-template cannot be combined with --template/);
		expect(runBootstrap).not.toHaveBeenCalled();
	});

	test("empty --skip-template -y --agent uses the existing-app path", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "neon-init-no-tmpl-"));
		const run = vi.fn().mockResolvedValue(true);
		const runBootstrap = nestedBootstrapOk();
		const { handler } = await import("./init.js");

		await handler(
			baseProps({
				cwd,
				run,
				yes: true,
				skipTemplate: true,
				agent: ["cursor"],
				contextFile: join(cwd, ".neon"),
				runBootstrap,
			}),
		);

		expect(runBootstrap).not.toHaveBeenCalled();
		expect(run.mock.calls.map((call) => call[0][0])).toEqual([
			"plugins",
			"link",
			"config",
		]);
	});

	test("empty interactive skip-template does not scaffold", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "neon-init-skip-tmpl-"));
		const run = vi.fn().mockResolvedValue(true);
		const runBootstrap = nestedBootstrapOk();
		const fetchCatalog = vi.fn(async () => []);
		const { handler } = await import("./init.js");

		await handler(
			baseProps({
				cwd,
				run,
				contextFile: join(cwd, ".neon"),
				runBootstrap,
				fetchTemplates: fetchCatalog,
				pickTemplate: async () => ({ kind: "skip" }),
				pickAgentSetup: async () => "skip",
				pickConfig: async () => false,
			}),
		);

		expect(runBootstrap).not.toHaveBeenCalled();
		expect(fetchCatalog).toHaveBeenCalledTimes(1);
		expect(run.mock.calls.map((call) => call[0][0])).toEqual(["link"]);
	});

	test("empty interactive template pick passes the catalog entry, not just the id", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "neon-init-pick-tmpl-"));
		const run = vi.fn().mockResolvedValue(true);
		const runBootstrap = nestedBootstrapOk();
		const catalogHono = {
			id: "hono",
			title: "Updated REST API",
			description: "Updated template source",
			requires: ["database" as const],
			source: {
				owner: "neondatabase",
				repo: "examples",
				ref: "main",
				subdir: "updated-hono",
			},
		};
		const { handler } = await import("./init.js");

		await handler(
			baseProps({
				cwd,
				run,
				contextFile: join(cwd, ".neon"),
				runBootstrap,
				fetchTemplates: async () => [catalogHono],
				pickTemplate: async (
					templates: readonly BootstrapTemplate[],
				) => {
					const [picked] = templates;
					if (picked === undefined) {
						throw new Error("expected catalog template");
					}
					return { kind: "template", template: picked };
				},
			}),
		);

		expect(run).not.toHaveBeenCalled();
		expect(runBootstrap.mock.calls[0][0].template).toBeUndefined();
		expect(runBootstrap.mock.calls[0][0].selectedTemplate).toEqual(
			catalogHono,
		);
		expect(runBootstrap.mock.calls[0][0]).toMatchObject({
			default: false,
			printBanner: false,
			linkNoConfig: true,
		});
	});

	test("empty --template hono -y is nested bootstrap --default with that id", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "neon-init-tmpl-y-"));
		const run = vi.fn().mockResolvedValue(true);
		const runBootstrap = nestedBootstrapOk();
		const { handler } = await import("./init.js");

		await handler(
			baseProps({
				cwd,
				run,
				yes: true,
				template: "hono",
				contextFile: join(cwd, ".neon"),
				runBootstrap,
			}),
		);

		expect(runBootstrap.mock.calls[0][0]).toMatchObject({
			template: "hono",
			default: true,
		});
	});

	test("empty --template forwards --project-id into nested link", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "neon-init-tmpl-proj-"));
		const run = vi.fn().mockResolvedValue(true);
		const runBootstrap = nestedBootstrapOk();
		const { handler } = await import("./init.js");

		await handler(
			baseProps({
				cwd,
				yes: true,
				template: "hono",
				projectId: "typed-proj",
				branch: "main",
				contextFile: join(cwd, ".neon"),
				runBootstrap,
			}),
		);

		expect(run).not.toHaveBeenCalled();
		expect(runBootstrap.mock.calls[0][0].linkExtra).toEqual([
			"--project-id",
			"typed-proj",
			"--branch",
			"main",
		]);
	});

	test("forwards --project-id only onto link", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "neon-init-proj-"));
		writeFileSync(join(cwd, "package.json"), "{}\n");
		writeFileSync(
			join(cwd, ".neon"),
			`${JSON.stringify({ projectId: "from-file", orgId: "org-file", branch: "main" })}\n`,
		);
		const run = vi.fn().mockResolvedValue(true);
		const { handler } = await import("./init.js");

		await handler(
			baseProps({
				cwd,
				run,
				yes: true,
				projectId: "typed-proj",
				contextFile: join(cwd, ".neon"),
				detectProjectAgents: () => ["cursor"],
			}),
		);

		const linkArgv = run.mock.calls.find(
			(call) => call[0][0] === "link",
		)?.[0];
		expect(linkArgv).toEqual(
			expect.arrayContaining(["--project-id", "typed-proj"]),
		);
		expect(linkArgv).not.toContain("from-file");
		expect(linkArgv).not.toContain("--org-id");
	});

	test("linked rerun without explicit link flags does not relink", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "neon-init-linked-norelink-"));
		writeFileSync(join(cwd, "package.json"), "{}\n");
		const contextFile = join(cwd, ".neon");
		writeFileSync(
			contextFile,
			`${JSON.stringify({ projectId: "proj-1", branch: "main" })}\n`,
		);
		const run = vi.fn().mockResolvedValue(true);
		const { handler } = await import("./init.js");

		await handler(
			baseProps({
				cwd,
				run,
				yes: true,
				contextFile,
				detectProjectAgents: () => ["cursor"],
			}),
		);

		expect(run.mock.calls.map((call) => call[0][0])).toEqual([
			"plugins",
			"config",
			"env",
		]);
	});

	test("pulls env after a new neon.ts when a branch is pinned", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "neon-init-env-"));
		writeFileSync(join(cwd, "package.json"), "{}\n");
		const contextFile = join(cwd, ".neon");
		writeFileSync(
			contextFile,
			`${JSON.stringify({ projectId: "proj-1", branch: "main" })}\n`,
		);
		const run = vi.fn().mockResolvedValue(true);
		const { handler } = await import("./init.js");

		await handler(
			baseProps({
				cwd,
				run,
				yes: true,
				contextFile,
				detectProjectAgents: () => ["cursor"],
			}),
		);

		expect(
			run.mock.calls
				.find((call) => call[0][0] === "env")?.[0]
				.slice(0, 2),
		).toEqual(["env", "pull"]);
	});

	test("env pull after neon.ts forwards an explicit API key", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "neon-init-env-key-"));
		writeFileSync(join(cwd, "package.json"), "{}\n");
		const contextFile = join(cwd, ".neon");
		writeFileSync(
			contextFile,
			`${JSON.stringify({ projectId: "proj-1", branch: "main" })}\n`,
		);
		const { recordCredentialInputs: record } = await import(
			"@neon-internals/cli-core/auth_selection"
		);
		record({
			apiKeyFlag: "napi_flag",
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
				contextFile,
				detectProjectAgents: () => ["cursor"],
			}),
		);

		expect(
			run.mock.calls.find((call) => call[0][0] === "env")?.[2],
		).toEqual({ NEON_API_KEY: "napi_flag" });
	});

	test("does not pull env when neon.ts already existed", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "neon-init-env-existed-"));
		writeFileSync(join(cwd, "package.json"), "{}\n");
		writeFileSync(join(cwd, "neon.ts"), "export default {};\n");
		const contextFile = join(cwd, ".neon");
		writeFileSync(
			contextFile,
			`${JSON.stringify({ projectId: "proj-1", branch: "main" })}\n`,
		);
		const run = vi.fn().mockResolvedValue(true);
		const { handler } = await import("./init.js");

		await handler(
			baseProps({
				cwd,
				run,
				yes: true,
				contextFile,
				detectProjectAgents: () => ["cursor"],
			}),
		);

		expect(run.mock.calls.map((call) => call[0][0])).not.toContain("env");
	});

	test("a failed env pull warns and still finishes", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "neon-init-env-fail-"));
		writeFileSync(join(cwd, "package.json"), "{}\n");
		const contextFile = join(cwd, ".neon");
		writeFileSync(
			contextFile,
			`${JSON.stringify({ projectId: "proj-1", branch: "main" })}\n`,
		);
		const run = vi.fn().mockImplementation(async (argv: string[]) => {
			return argv[0] !== "env";
		});
		const { handler } = await import("./init.js");
		const { log } = await import("../log.js");
		const warning = vi.spyOn(log, "warning");

		await handler(
			baseProps({
				cwd,
				run,
				yes: true,
				contextFile,
				detectProjectAgents: () => ["cursor"],
			}),
		);

		expect(run.mock.calls.map((call) => call[0][0])).toContain("env");
		expect(warning).toHaveBeenCalled();
		expect(String(warning.mock.calls[0]?.[0])).toMatch(
			/pulling its Neon env vars failed/,
		);
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
			/forwarded to plugins, or to skills and mcp/i,
		);
		expect(help).toMatch(/Plugin agents/);
		expect(help).toMatch(/Skills and MCP agents/);
		expect(help).toMatch(/--skip-template/);
		expect(help).toMatch(/--no-config/);
		expect(help).toMatch(/Create neon.ts/);
		expect(help).toMatch(/skip scaffolding/i);
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

	cliTest(
		"rejects --no-config with --services",
		async ({ testCliCommand }) => {
			const { stderr } = await testCliCommand(
				["init", "--no-config", "--services", "auth"],
				{ snapshot: false, code: 1, outputTable: true },
			);
			expect(stderr).toMatch(
				/--no-config cannot be combined with --services/,
			);
		},
	);

	cliTest(
		"rejects --template with --skip-template",
		async ({ testCliCommand }) => {
			const { stderr } = await testCliCommand(
				["init", "--template", "hono", "--skip-template"],
				{ snapshot: false, code: 1, outputTable: true },
			);
			expect(stderr).toMatch(
				/--skip-template cannot be combined with --template/,
			);
		},
	);
});

describe("init flag parsing", () => {
	const parse = async (args: string[]) =>
		(await builder(
			yargs().scriptName("neon").exitProcess(false),
		).parseAsync(args)) as {
			config?: boolean;
			skipTemplate?: boolean;
			template?: string;
		};

	test("--config is a three-state flag", async () => {
		expect((await parse([])).config).toBeUndefined();
		expect((await parse(["--config"])).config).toBe(true);
		expect((await parse(["--no-config"])).config).toBe(false);
	});

	test("--skip-template is not the negation of --template", async () => {
		expect((await parse(["--skip-template"])).skipTemplate).toBe(true);
		expect((await parse(["--skip-template"])).template).toBeUndefined();
		expect((await parse(["--template", "hono"])).template).toBe("hono");
		expect((await parse(["--template", "hono"])).skipTemplate).toBe(false);
	});

	test("--services none is the raw none token", async () => {
		const argv = (await builder(
			yargs().scriptName("neon").exitProcess(false),
		).parseAsync(["--services", "none"])) as { services?: unknown };
		expect(argv.services).toEqual(["none"]);
	});
});
