import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { neonMcpUrl } from "./install.js";
import { type ResolveMcpPlanOptions, resolveMcpPlan } from "./plan.js";
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

function planOptions(
	cwd: string,
	overrides: Partial<ResolveMcpPlanOptions> = {},
): ResolveMcpPlanOptions {
	return {
		project: false,
		oauth: false,
		agents: ["cursor"],
		yes: false,
		cwd,
		interactive: true,
		readOnly: false,
		categories: [],
		...overrides,
	};
}

describe("resolveMcpPlan", () => {
	test("-y is global, specified agents, minted API key, and calls no prompts", async () => {
		const cwd = tmpDir();
		const plan = await resolveMcpPlan(
			planOptions(cwd, {
				yes: true,
				pickScope: async () => {
					throw new Error("scope prompt");
				},
				pickAgents: async () => {
					throw new Error("agent prompt");
				},
				pickAuth: async () => {
					throw new Error("auth prompt");
				},
				pickProjectPin: async () => {
					throw new Error("pin prompt");
				},
			}),
		);
		expect(plan).toEqual({
			scope: "global",
			agents: ["cursor"],
			auth: "api-key",
			readOnly: false,
			urlProjectId: undefined,
			categories: [],
		});
	});

	test("interactive asks scope, then agents, then auth, then pin for project scope", async () => {
		const cwd = tmpDir();
		mkdirSync(join(cwd, ".cursor"));
		const calls: string[] = [];
		const plan = await resolveMcpPlan(
			planOptions(cwd, {
				agents: [],
				linkedProjectId: "proj-linked",
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
				pickProjectPin: async (linked) => {
					calls.push("pin");
					expect(linked).toBe("proj-linked");
					return true;
				},
			}),
		);
		expect(calls).toEqual(["scope", "agents", "auth", "pin"]);
		expect(plan).toEqual({
			scope: "project",
			agents: ["cursor"],
			auth: "oauth",
			readOnly: false,
			urlProjectId: "proj-linked",
			categories: [],
		});
	});

	test("interactive global never asks to pin a project", async () => {
		const cwd = tmpDir();
		const plan = await resolveMcpPlan(
			planOptions(cwd, {
				pickScope: async () => "global",
				pickAuth: async () => "api-key",
				pickProjectPin: async () => {
					throw new Error("pin prompt");
				},
			}),
		);
		expect(plan.scope).toBe("global");
		expect(plan.urlProjectId).toBeUndefined();
	});

	test("--project skips the scope prompt", async () => {
		const cwd = tmpDir();
		const plan = await resolveMcpPlan(
			planOptions(cwd, {
				project: true,
				pickScope: async () => {
					throw new Error("scope prompt");
				},
				pickAuth: async () => "api-key",
				pickProjectPin: async () => false,
			}),
		);
		expect(plan.scope).toBe("project");
		expect(plan.agents).toEqual(["cursor"]);
	});

	test("--oauth skips the auth prompt", async () => {
		const cwd = tmpDir();
		const plan = await resolveMcpPlan(
			planOptions(cwd, {
				oauth: true,
				pickScope: async () => "global",
				pickAuth: async () => {
					throw new Error("auth prompt");
				},
			}),
		);
		expect(plan.auth).toBe("oauth");
	});

	test("--agent skips the agent picker", async () => {
		const cwd = tmpDir();
		const plan = await resolveMcpPlan(
			planOptions(cwd, {
				agents: ["claude"],
				pickScope: async () => "global",
				pickAgents: async () => {
					throw new Error("agent prompt");
				},
				pickAuth: async () => "api-key",
			}),
		);
		expect(plan.agents).toEqual(["claude-code"]);
	});

	test("--project-id skips the pin prompt", async () => {
		const cwd = tmpDir();
		const plan = await resolveMcpPlan(
			planOptions(cwd, {
				project: true,
				projectId: "proj-flag",
				pickAuth: async () => "oauth",
				pickProjectPin: async () => {
					throw new Error("pin prompt");
				},
			}),
		);
		expect(plan.urlProjectId).toBe("proj-flag");
	});

	test("-y --project does not infer a URL project from .neon", async () => {
		const cwd = tmpDir();
		mkdirSync(join(cwd, ".cursor"));
		const plan = await resolveMcpPlan(
			planOptions(cwd, {
				project: true,
				yes: true,
				agents: [],
				linkedProjectId: "proj-from-neon",
				pickProjectPin: async () => {
					throw new Error("pin prompt");
				},
			}),
		);
		expect(plan.scope).toBe("project");
		expect(plan.urlProjectId).toBeUndefined();
	});

	test("pin yes without a linked project is not asked", async () => {
		const cwd = tmpDir();
		const plan = await resolveMcpPlan(
			planOptions(cwd, {
				project: true,
				oauth: true,
				pickProjectPin: async () => {
					throw new Error("pin prompt");
				},
			}),
		);
		expect(plan.urlProjectId).toBeUndefined();
	});

	test("pin no omits projectId", async () => {
		const cwd = tmpDir();
		const plan = await resolveMcpPlan(
			planOptions(cwd, {
				project: true,
				oauth: true,
				linkedProjectId: "proj-linked",
				pickProjectPin: async () => false,
			}),
		);
		expect(plan.urlProjectId).toBeUndefined();
	});

	test("project scope preselects folder detection, not a global install", async () => {
		const cwd = tmpDir();
		let selected: string[] | undefined;
		const plan = await resolveMcpPlan(
			planOptions(cwd, {
				project: true,
				oauth: true,
				agents: [],
				pickAgents: async (options) => {
					selected = [...(options.selected ?? [])];
					return ["cursor"];
				},
				pickProjectPin: async () => false,
			}),
		);
		expect(selected).toEqual([]);
		expect(plan.scope).toBe("project");
		expect(plan.agents).toEqual(["cursor"]);
	});

	test("non-interactive project with no folder agents fails", async () => {
		const cwd = tmpDir();
		await expect(
			resolveMcpPlan(
				planOptions(cwd, {
					project: true,
					agents: [],
					yes: true,
					interactive: false,
				}),
			),
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
				url: neonMcpUrl(),
			}),
		).toBe(
			[
				"Config: global",
				"Agents: Cursor",
				"Auth: mint an account-wide API key that reaches every organization",
				`URL: ${neonMcpUrl()}`,
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
				url: neonMcpUrl({ projectId: "proj-1" }),
			}),
		).toContain("reuse the API key already in agent config");
		expect(
			mcpInstallSummary({
				scope: "global",
				install: ["cursor"],
				skipped: [],
				auth: "oauth",
				reuse: false,
				url: neonMcpUrl({ readOnly: true }),
			}),
		).toContain("OAuth (agent signs in on first use)");
	});

	test("project-scope mint is still an account-wide key", () => {
		expect(
			mcpInstallSummary({
				scope: "project",
				install: ["cursor"],
				skipped: [],
				auth: "api-key",
				reuse: false,
				url: neonMcpUrl(),
			}),
		).toContain(
			"mint an account-wide API key that reaches every organization",
		);
	});
});
