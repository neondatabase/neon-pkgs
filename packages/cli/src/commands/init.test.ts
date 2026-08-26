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

	test("empty directory runs bootstrap --no-link, skills, link, mcp", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "neon-init-empty-"));
		const run = vi.fn().mockResolvedValue(true);
		const { handler } = await import("./init.js");

		await handler(
			baseProps({
				cwd,
				run,
				contextFile: join(cwd, ".neon"),
			}),
		);

		expect(run.mock.calls.map((call) => call[0][0])).toEqual([
			"bootstrap",
			"skills",
			"link",
			"mcp",
		]);
		expect(run.mock.calls[0][0].slice(0, 3)).toEqual([
			"bootstrap",
			".",
			"--no-link",
		]);
		expect(run.mock.calls[1][0].slice(0, 1)).toEqual(["skills"]);
	});

	test("existing app runs skills, link, mcp", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "neon-init-app-"));
		writeFileSync(join(cwd, "package.json"), "{}\n");
		const run = vi.fn().mockResolvedValue(true);
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
			"link",
			"mcp",
		]);
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
		]);
	});

	test("empty -y inserts link --yes before mcp", async () => {
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

		expect(run.mock.calls[0][0].slice(0, 4)).toEqual([
			"bootstrap",
			".",
			"--default",
			"--no-link",
		]);
		expect(run.mock.calls[1][0].slice(0, 2)).toEqual(["skills", "-y"]);
		expect(run.mock.calls[2][0].slice(0, 2)).toEqual(["link", "--yes"]);
		expect(run.mock.calls[3][0].slice(0, 2)).toEqual(["mcp", "-y"]);
		expect(run).toHaveBeenCalledTimes(4);
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

	test("passes NEON_API_KEY only to link and mcp", async () => {
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
			["bootstrap", undefined],
			["skills", undefined],
			["link", { NEON_API_KEY: "napi_test" }],
			["mcp", { NEON_API_KEY: "napi_test" }],
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
			"link",
			"mcp",
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

	test("interactive plugin: plugins then link, not skills or mcp", async () => {
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
		]);
	});

	test("interactive skip: link only", async () => {
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

		expect(run.mock.calls.map((call) => call[0][0])).toEqual(["link"]);
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
		]);
		expect(run.mock.calls[0][0].slice(0, 2)).toEqual(["plugins", "-y"]);
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
			"link",
			"mcp",
		]);
	});

	test("-y plugin detection runs after bootstrap", async () => {
		const cwd = mkdtempSync(join(tmpdir(), "neon-init-y-after-boot-"));
		const run = vi.fn().mockResolvedValue(true);
		const hasProjectPlugins = vi.fn(async () => {
			expect(run.mock.calls.map((call) => call[0][0])).toEqual([
				"bootstrap",
			]);
			return true;
		});
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

		expect(hasProjectPlugins).toHaveBeenCalledWith(cwd);
		expect(run.mock.calls.map((call) => call[0][0])).toEqual([
			"bootstrap",
			"plugins",
			"link",
		]);
	});

	test("strips an ambient NEON_API_KEY from bootstrap, skills, and plugins", async () => {
		const { initChildEnv } = await import("./init.js");
		const base = { PATH: "/bin", NEON_API_KEY: "napi_env" };
		expect(initChildEnv("bootstrap", undefined, base)).toEqual({
			PATH: "/bin",
		});
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
			initChildEnv("bootstrap", undefined, {
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
