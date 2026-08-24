import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { resolveMcpPlan } from "./plan.js";
import { mcpInstallSummary } from "./wizard.js";

const dirs: string[] = [];

afterEach(() => {
	for (const dir of dirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

function tmpDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "neon-mcp-plan-"));
	dirs.push(dir);
	return dir;
}

describe("resolveMcpPlan", () => {
	test("-y is global, specified agents, minted API key, and calls no prompts", async () => {
		const cwd = tmpDir();
		const plan = await resolveMcpPlan({
			project: false,
			oauth: false,
			agents: ["cursor"],
			yes: true,
			cwd,
			interactive: true,
			pickScope: async () => {
				throw new Error("scope prompt");
			},
			pickAgents: async () => {
				throw new Error("agent prompt");
			},
			pickAuth: async () => {
				throw new Error("auth prompt");
			},
		});
		expect(plan).toEqual({
			scope: "global",
			agents: ["cursor"],
			auth: "api-key",
		});
	});

	test("interactive asks scope, then agents, then auth", async () => {
		const cwd = tmpDir();
		mkdirSync(join(cwd, ".cursor"));
		const calls: string[] = [];
		const plan = await resolveMcpPlan({
			project: false,
			oauth: false,
			agents: [],
			yes: false,
			cwd,
			interactive: true,
			pickScope: async () => {
				calls.push("scope");
				return "project";
			},
			pickAgents: async (options) => {
				calls.push("agents");
				expect(options.selected).toEqual(["cursor"]);
				return ["cursor"];
			},
			pickAuth: async () => {
				calls.push("auth");
				return "oauth";
			},
		});
		expect(calls).toEqual(["scope", "agents", "auth"]);
		expect(plan).toEqual({
			scope: "project",
			agents: ["cursor"],
			auth: "oauth",
		});
	});

	test("--project skips the scope prompt", async () => {
		const cwd = tmpDir();
		const plan = await resolveMcpPlan({
			project: true,
			oauth: false,
			agents: ["cursor"],
			yes: false,
			cwd,
			interactive: true,
			pickScope: async () => {
				throw new Error("scope prompt");
			},
			pickAuth: async () => "api-key",
		});
		expect(plan.scope).toBe("project");
		expect(plan.agents).toEqual(["cursor"]);
	});

	test("--oauth skips the auth prompt", async () => {
		const cwd = tmpDir();
		const plan = await resolveMcpPlan({
			project: false,
			oauth: true,
			agents: ["cursor"],
			yes: false,
			cwd,
			interactive: true,
			pickScope: async () => "global",
			pickAuth: async () => {
				throw new Error("auth prompt");
			},
		});
		expect(plan.auth).toBe("oauth");
	});

	test("--agent skips the agent picker", async () => {
		const cwd = tmpDir();
		const plan = await resolveMcpPlan({
			project: false,
			oauth: false,
			agents: ["claude"],
			yes: false,
			cwd,
			interactive: true,
			pickScope: async () => "global",
			pickAgents: async () => {
				throw new Error("agent prompt");
			},
			pickAuth: async () => "api-key",
		});
		expect(plan.agents).toEqual(["claude-code"]);
	});

	test("project scope preselects folder detection, not a global install", async () => {
		const cwd = tmpDir();
		let selected: string[] | undefined;
		const plan = await resolveMcpPlan({
			project: true,
			oauth: true,
			agents: [],
			yes: false,
			cwd,
			interactive: true,
			pickAgents: async (options) => {
				selected = [...(options.selected ?? [])];
				return ["cursor"];
			},
		});
		expect(selected).toEqual([]);
		expect(plan.scope).toBe("project");
		expect(plan.agents).toEqual(["cursor"]);
	});

	test("non-interactive project with no folder agents fails", async () => {
		const cwd = tmpDir();
		await expect(
			resolveMcpPlan({
				project: true,
				oauth: false,
				agents: [],
				yes: true,
				cwd,
				interactive: false,
			}),
		).rejects.toThrow(/No coding agents detected in this project/);
	});
});

describe("mcpInstallSummary", () => {
	test("lists only agents that will be written", () => {
		expect(
			mcpInstallSummary({
				scope: "global",
				install: ["cursor"],
				skipped: [
					{
						agent: "claude-desktop",
						error: "Add remote servers through Connectors in the app",
					},
				],
				auth: "api-key",
				reuse: false,
			}),
		).toBe(
			[
				"Scope: global",
				"Agents: Cursor",
				"Auth: mint an account-wide API key",
				"Skipped: Claude Desktop (Add remote servers through Connectors in the app)",
			].join("\n"),
		);
	});

	test("names reuse and OAuth", () => {
		expect(
			mcpInstallSummary({
				scope: "project",
				install: ["cursor", "claude-code"],
				skipped: [],
				auth: "api-key",
				reuse: true,
			}),
		).toContain("reuse the API key already in agent config");
		expect(
			mcpInstallSummary({
				scope: "global",
				install: ["cursor"],
				skipped: [],
				auth: "oauth",
				reuse: false,
			}),
		).toContain("OAuth (agent signs in on first use)");
	});
});
