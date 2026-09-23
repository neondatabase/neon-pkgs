import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import {
	MCP_CONFIG_LOCATION_PROJECT_CONFLICT,
	MCP_SCOPED_AND_PROJECT_ID,
	MCP_SCOPED_NEEDS_PROJECT,
} from "../init/copy.js";
import { type ResolveMcpPlanOptions, resolveMcpPlan } from "./plan.js";

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
		mcpProjectScoped: false,
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

	test("interactive asks scope, then agents, then auth, and does not pin", async () => {
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
			}),
		);
		expect(calls).toEqual(["scope", "agents", "auth"]);
		expect(plan).toEqual({
			scope: "project",
			agents: ["cursor"],
			auth: "oauth",
			readOnly: false,
			urlProjectId: undefined,
			categories: [],
		});
	});

	test("interactive global never sets a URL project from .neon", async () => {
		const cwd = tmpDir();
		const plan = await resolveMcpPlan(
			planOptions(cwd, {
				linkedProjectId: "proj-linked",
				pickScope: async () => "global",
				pickAuth: async () => "api-key",
			}),
		);
		expect(plan.scope).toBe("global");
		expect(plan.urlProjectId).toBeUndefined();
	});

	test("--mcp-config-location project skips the scope prompt", async () => {
		const cwd = tmpDir();
		const plan = await resolveMcpPlan(
			planOptions(cwd, {
				mcpConfigLocation: "project",
				pickScope: async () => {
					throw new Error("scope prompt");
				},
				pickAuth: async () => "api-key",
			}),
		);
		expect(plan.scope).toBe("project");
		expect(plan.agents).toEqual(["cursor"]);
	});

	test("--project is an alias for --mcp-config-location project", async () => {
		const cwd = tmpDir();
		const plan = await resolveMcpPlan(
			planOptions(cwd, {
				project: true,
				pickScope: async () => {
					throw new Error("scope prompt");
				},
				pickAuth: async () => "api-key",
			}),
		);
		expect(plan.scope).toBe("project");
	});

	test("--project with --mcp-config-location global fails", async () => {
		const cwd = tmpDir();
		await expect(
			resolveMcpPlan(
				planOptions(cwd, {
					mcpConfigLocation: "global",
					project: true,
					pickAuth: async () => "api-key",
				}),
			),
		).rejects.toThrow(MCP_CONFIG_LOCATION_PROJECT_CONFLICT);
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

	test("specified agents skip the agent picker", async () => {
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

	test("-y --mcp-config-location project uses the host CLI agent when the project has no folders", async () => {
		const cwd = tmpDir();
		const plan = await resolveMcpPlan(
			planOptions(cwd, {
				agents: [],
				yes: true,
				interactive: false,
				mcpConfigLocation: "project",
				detectAgent: () => "cursor",
				pickAgents: async () => {
					throw new Error("agent prompt");
				},
				pickAuth: async () => {
					throw new Error("auth prompt");
				},
			}),
		);
		expect(plan.scope).toBe("project");
		expect(plan.agents).toEqual(["cursor"]);
		expect(plan.auth).toBe("api-key");
	});

	test("-y --mcp-config-location project with no folders or host fails", async () => {
		const cwd = tmpDir();
		await expect(
			resolveMcpPlan(
				planOptions(cwd, {
					agents: [],
					yes: true,
					interactive: false,
					mcpConfigLocation: "project",
					detectAgent: () => null,
				}),
			),
		).rejects.toThrow(/omit -y in a terminal/);
	});

	test("--mcp-project-scoped uses the linked project", async () => {
		const cwd = tmpDir();
		mkdirSync(join(cwd, ".cursor"));
		const plan = await resolveMcpPlan(
			planOptions(cwd, {
				mcpConfigLocation: "project",
				mcpProjectScoped: true,
				agents: ["cursor"],
				linkedProjectId: "proj-linked",
				pickAuth: async () => "api-key",
			}),
		);
		expect(plan.auth).toBe("api-key");
		expect(plan.urlProjectId).toBe("proj-linked");
	});

	test("--project-id pins that id without --mcp-project-scoped", async () => {
		const cwd = tmpDir();
		const plan = await resolveMcpPlan(
			planOptions(cwd, {
				mcpConfigLocation: "project",
				projectId: "proj-flag",
				pickAuth: async () => "oauth",
			}),
		);
		expect(plan.urlProjectId).toBe("proj-flag");
	});

	test("-y --mcp-config-location project does not infer a URL project from .neon", async () => {
		const cwd = tmpDir();
		mkdirSync(join(cwd, ".cursor"));
		const plan = await resolveMcpPlan(
			planOptions(cwd, {
				mcpConfigLocation: "project",
				yes: true,
				agents: [],
				linkedProjectId: "proj-from-neon",
			}),
		);
		expect(plan.scope).toBe("project");
		expect(plan.urlProjectId).toBeUndefined();
	});

	test("--mcp-project-scoped without a linked project fails", async () => {
		const cwd = tmpDir();
		await expect(
			resolveMcpPlan(
				planOptions(cwd, {
					mcpConfigLocation: "project",
					mcpProjectScoped: true,
					oauth: true,
				}),
			),
		).rejects.toThrow(MCP_SCOPED_NEEDS_PROJECT);
	});

	test("--mcp-project-scoped cannot combine with --project-id", async () => {
		const cwd = tmpDir();
		await expect(
			resolveMcpPlan(
				planOptions(cwd, {
					mcpProjectScoped: true,
					projectId: "proj-flag",
					linkedProjectId: "proj-linked",
					oauth: true,
				}),
			),
		).rejects.toThrow(MCP_SCOPED_AND_PROJECT_ID);
	});

	test("project location preselects folder detection, not a global install", async () => {
		const cwd = tmpDir();
		let selected: string[] | undefined;
		const plan = await resolveMcpPlan(
			planOptions(cwd, {
				mcpConfigLocation: "project",
				oauth: true,
				agents: [],
				pickAgents: async (options) => {
					selected = [...(options.selected ?? [])];
					return ["cursor"];
				},
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
					mcpConfigLocation: "project",
					agents: [],
					yes: true,
					interactive: false,
					detectAgent: () => null,
				}),
			),
		).rejects.toThrow(/No coding agents detected in this project/);
	});
});
