import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordCredentialInputs } from "@neon-internals/cli-core/auth_selection";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

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

	test("empty directory runs only bootstrap .", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "neon-init-empty-"));
		const run = vi.fn().mockResolvedValue(true);
		const stdout = vi.spyOn(process.stdout, "write").mockReturnValue(true);
		const { handler } = await import("./init.js");

		await handler(
			baseProps({
				cwd,
				run,
				contextFile: join(cwd, ".neon"),
			}),
		);

		expect(run.mock.calls.map((call) => call[0].slice(0, 2))).toEqual([
			["bootstrap", "."],
		]);
		expect(run).toHaveBeenCalledTimes(1);
		const out = stdout.mock.calls.map((call) => String(call[0])).join("");
		expect(out).not.toContain("Neon is ready");
		expect(out).not.toContain("██████╗");
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
		expect(out).toContain("Neon is ready.");
		expect(out).not.toContain("INFO:");
		expect(out).not.toContain("██████╗");
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

		await handler(baseProps({ cwd, run, contextFile }));

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

		await handler(baseProps({ cwd, run, contextFile }));

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
	});

	test("empty -y does not detect agents in the parent", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "neon-init-y-empty-detect-"));
		const run = vi.fn().mockResolvedValue(true);
		const hasProjectPlugins = vi.fn(async () => true);
		const { handler } = await import("./init.js");

		await handler(
			baseProps({
				cwd,
				run,
				yes: true,
				contextFile: join(cwd, ".neon"),
				hasProjectPlugins,
			}),
		);

		expect(hasProjectPlugins).not.toHaveBeenCalled();
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
		expect(help).not.toMatch(/claude-desktop/);
		expect(help).not.toMatch(/Set output format/);
	});

	cliTest("rejects --data", async ({ testCliCommand }) => {
		await testCliCommand(["init", "--data", '{"step":"auth"}'], {
			snapshot: false,
			code: 1,
			stderr: expect.stringContaining("were removed"),
		});
	});

	cliTest("rejects --agent", async ({ testCliCommand }) => {
		await testCliCommand(["init", "--agent"], {
			snapshot: false,
			code: 1,
			stderr: expect.stringContaining("Run `neon init`"),
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
});
