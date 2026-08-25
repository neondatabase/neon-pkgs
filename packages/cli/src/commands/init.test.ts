import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";

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

describe("init handler", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.resetModules();
	});

	test("empty directory runs bootstrap, skills update, mcp", async () => {
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
			"mcp",
		]);
		expect(run.mock.calls[0][0].slice(0, 2)).toEqual(["bootstrap", "."]);
		expect(run.mock.calls[1][0].slice(0, 2)).toEqual(["skills", "update"]);
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
		expect(run.mock.calls[1][0].slice(0, 3)).toEqual([
			"skills",
			"update",
			"-y",
		]);
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
});

describe("init CLI", () => {
	cliTest("help describes the orchestrator", async ({ testCliCommand }) => {
		await testCliCommand(["init", "--help"], {
			snapshot: false,
			stderr: expect.stringContaining("skills update"),
		});
	});

	cliTest("rejects --data", async ({ testCliCommand }) => {
		await testCliCommand(["init", "--data", '{"step":"auth"}'], {
			snapshot: false,
			code: 1,
			stderr: expect.stringMatching(/Unknown argument: data/i),
		});
	});

	cliTest("rejects --agent", async ({ testCliCommand }) => {
		await testCliCommand(["init", "--agent"], {
			snapshot: false,
			code: 1,
			stderr: expect.stringMatching(/Unknown argument: agent/i),
		});
	});
});
