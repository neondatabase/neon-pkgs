import { afterEach, describe, expect, test } from "vitest";
import { defineConfig } from "./define-config.js";
import { PushConflictError } from "./errors.js";
import { FakeNeonApi } from "./fake-neon-api.js";
import { pushConfig } from "./push-config.js";
import { makeTempRepo } from "./test-utils.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
	while (cleanups.length > 0) cleanups.shift()?.();
});

function setup(files: Record<string, string | null>) {
	const repo = makeTempRepo(files);
	cleanups.push(repo.cleanup);
	return repo.root;
}

function seededFake(): { api: FakeNeonApi; projectId: string } {
	const api = new FakeNeonApi();
	const projectId = "proj-1";
	api.seedProject({
		project: {
			id: projectId,
			name: "my-app",
			regionId: "aws-us-east-1",
			pgVersion: 17,
			orgId: "org-1",
		},
	});
	return { api, projectId };
}

describe("pushConfig — additive operations", () => {
	test("creates a missing concrete branch", async () => {
		const { api, projectId } = seededFake();
		const config = defineConfig({
			project: { name: "my-app" },
			branches: {
				production: {},
				staging: { parent: "production" },
			},
		});
		const result = await pushConfig(config, { api, projectId });
		expect(result.conflicts).toHaveLength(0);
		expect(result.applied).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ kind: "project", action: "noop" }),
				expect.objectContaining({
					kind: "branch",
					action: "create",
					identifier: "staging",
				}),
			]),
		);
		const branches = await api.listBranches(projectId);
		expect(branches.map((b) => b.name).sort()).toEqual([
			"production",
			"staging",
		]);
	});

	test("creates a new project when one doesn't exist (with orgId+region)", async () => {
		const api = new FakeNeonApi();
		const config = defineConfig({
			project: { name: "brand-new", region: "aws-us-east-1" },
			branches: { production: {} },
		});
		const result = await pushConfig(config, { api, orgId: "org-1" });
		expect(result.applied[0]).toEqual(
			expect.objectContaining({ kind: "project", action: "create" }),
		);
		const created = await api.getProject(result.projectId);
		expect(created.name).toBe("brand-new");
		expect(created.orgId).toBe("org-1");
	});

	test("fails to create a project without region", async () => {
		const api = new FakeNeonApi();
		const config = defineConfig({
			project: { name: "missing-region" },
			branches: { production: {} },
		});
		await expect(
			pushConfig(config, { api, orgId: "org-1" }),
		).rejects.toThrow(/region/);
	});

	test("reuses an existing project with matching name in the same org", async () => {
		const api = new FakeNeonApi();
		api.seedProject({
			project: {
				id: "proj-existing",
				name: "my-app",
				regionId: "aws-us-east-1",
				pgVersion: 17,
				orgId: "org-1",
			},
		});
		const config = defineConfig({
			project: { name: "my-app", region: "aws-us-east-1" },
			branches: { production: {} },
		});
		const result = await pushConfig(config, { api, orgId: "org-1" });
		expect(result.projectId).toBe("proj-existing");
		expect(result.applied[0]).toEqual(
			expect.objectContaining({ kind: "project", action: "noop" }),
		);
	});

	test("applies `protected: true` on creating a branch", async () => {
		const { api, projectId } = seededFake();
		const config = defineConfig({
			project: { name: "my-app" },
			branches: {
				production: {},
				staging: { parent: "production", protected: true },
			},
		});
		await pushConfig(config, { api, projectId });
		const branches = await api.listBranches(projectId);
		const staging = branches.find((b) => b.name === "staging");
		expect(staging?.protected).toBe(true);
	});

	test("with updateExisting:true, toggles `protected` on an existing branch", async () => {
		const { api, projectId } = seededFake();
		const config = defineConfig({
			project: { name: "my-app" },
			branches: { production: { protected: true } },
		});
		const result = await pushConfig(config, {
			api,
			projectId,
			updateExisting: true,
		});
		expect(result.conflicts).toHaveLength(0);
		const branches = await api.listBranches(projectId);
		expect(branches.find((b) => b.name === "production")?.protected).toBe(
			true,
		);
	});

	test("fails when multiple projects in the org share the same name", async () => {
		const api = new FakeNeonApi();
		api.seedProject({
			project: {
				id: "p1",
				name: "dup",
				regionId: "aws-us-east-1",
				pgVersion: 17,
				orgId: "org-1",
			},
		});
		api.seedProject({
			project: {
				id: "p2",
				name: "dup",
				regionId: "aws-us-east-1",
				pgVersion: 17,
				orgId: "org-1",
			},
		});
		await expect(
			pushConfig(
				defineConfig({
					project: { name: "dup", region: "aws-us-east-1" },
				}),
				{
					api,
					orgId: "org-1",
				},
			),
		).rejects.toThrow(/Multiple Neon projects/);
	});
});

describe("pushConfig — API key scopes", () => {
	test("works with a project-scoped key flow: getProject path is taken when projectId is supplied", async () => {
		// Simulate a project-scoped key by giving the fake api a listProjects implementation
		// that throws 403. The push must succeed because getProject is the only call needed
		// when projectId is provided.
		const { api, projectId } = seededFake();
		const guarded = Object.create(api) as typeof api;
		guarded.listProjects = async () => {
			throw Object.assign(new Error("Forbidden"), {
				response: { status: 403 },
			});
		};
		const config = defineConfig({
			project: { name: "my-app", region: "aws-us-east-1" },
			branches: {
				production: {},
				staging: { parent: "production" },
			},
		});
		const result = await pushConfig(config, { api: guarded, projectId });
		expect(result.applied.some((a) => a.identifier === "staging")).toBe(
			true,
		);
	});

	test("project-scoped key without projectId surfaces PLATFORM_INSUFFICIENT_SCOPE", async () => {
		const guarded = {
			listProjects: async () => {
				throw Object.assign(new Error("Forbidden"), {
					response: { status: 403 },
				});
			},
			getProject: () => Promise.reject(new Error("not used")),
			createProject: () => Promise.reject(new Error("not used")),
			updateProject: () => Promise.reject(new Error("not used")),
			listBranches: () => Promise.reject(new Error("not used")),
			createBranch: () => Promise.reject(new Error("not used")),
			updateBranch: () => Promise.reject(new Error("not used")),
			listEndpoints: () => Promise.reject(new Error("not used")),
			updateEndpoint: () => Promise.reject(new Error("not used")),
		} as unknown as Parameters<typeof pushConfig>[1] extends infer T
			? T extends { api?: infer A }
				? A
				: never
			: never;
		const config = defineConfig({
			project: { name: "my-app", region: "aws-us-east-1" },
		});
		await expect(
			pushConfig(config, { api: guarded }),
		).rejects.toMatchObject({
			code: "PLATFORM_INSUFFICIENT_SCOPE",
		});
	});
});

describe("pushConfig — conflict handling", () => {
	test("by default, refuses to apply when there are conflicts", async () => {
		const { api, projectId } = seededFake();
		const config = defineConfig({
			project: { name: "my-app", region: "aws-us-east-1" },
			branches: {
				production: { computeSettings: { autoscalingLimitMaxCu: 4 } },
			},
		});
		await expect(pushConfig(config, { api, projectId })).rejects.toThrow(
			PushConflictError,
		);
	});

	test("with applyChanges:true, applies branch-level drift instead of failing", async () => {
		const { api, projectId } = seededFake();
		const config = defineConfig({
			project: { name: "my-app", region: "aws-us-east-1" },
			branches: {
				production: { computeSettings: { autoscalingLimitMaxCu: 4 } },
			},
		});
		const result = await pushConfig(config, {
			api,
			projectId,
			applyChanges: true,
		});
		// applyChanges promotes branch-level drift from "conflict" to "applied" — that's the
		// whole point of the flag. Project-level conflicts (immutable region) still surface
		// separately, but there are none here.
		expect(result.conflicts).toHaveLength(0);
		expect(result.applied).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					kind: "branch",
					action: "update",
					identifier: "production",
				}),
			]),
		);
		const branches = await api.listBranches(projectId);
		const prodBranchId = branches.find((b) => b.name === "production")?.id;
		const endpoints = await api.listEndpoints(projectId);
		const prodEndpoint = endpoints.find((e) => e.branchId === prodBranchId);
		expect(prodEndpoint?.autoscalingLimitMaxCu).toBe(4);
	});

	test("applyChanges:true still surfaces immutable project-level conflicts (region)", async () => {
		const { api, projectId } = seededFake();
		const config = defineConfig({
			project: { name: "my-app", region: "aws-eu-central-1" },
		});
		// Region is immutable on Neon; even applyChanges:true cannot patch it. We surface the
		// conflict and let the caller decide. (The diff records it; pushConfig does not throw
		// because applyChanges suppressed the fail-fast guard.)
		const result = await pushConfig(config, {
			api,
			projectId,
			applyChanges: true,
		});
		expect(result.conflicts).toEqual([
			expect.objectContaining({ kind: "project", field: "region" }),
		]);
	});

	test("with updateExisting:true (without applyChanges), applies branch updates and clears branch conflicts", async () => {
		const { api, projectId } = seededFake();
		const config = defineConfig({
			project: { name: "my-app", region: "aws-us-east-1" },
			branches: {
				production: { computeSettings: { autoscalingLimitMaxCu: 2 } },
			},
		});
		const result = await pushConfig(config, {
			api,
			projectId,
			updateExisting: true,
		});
		expect(result.conflicts).toHaveLength(0);
		expect(result.applied).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					kind: "branch",
					action: "update",
					identifier: "production",
				}),
			]),
		);
	});

	test("region conflicts are always reported (immutable on Neon)", async () => {
		const { api, projectId } = seededFake();
		const config = defineConfig({
			project: { name: "my-app", region: "aws-eu-central-1" },
		});
		await expect(
			pushConfig(config, { api, projectId, updateExisting: true }),
		).rejects.toThrow(PushConflictError);
	});
});

describe("pushConfig — wildcard blueprints", () => {
	test("default: matching existing branches are reported as skipped, not modified", async () => {
		const api = new FakeNeonApi();
		const projectId = "proj-w";
		api.seedProject({
			project: {
				id: projectId,
				name: "my-app",
				regionId: "aws-us-east-1",
				pgVersion: 17,
			},
			branches: [
				{
					branch: {
						id: "br-prod",
						name: "production",
						isDefault: true,
					},
				},
				{
					branch: {
						id: "br-p1",
						name: "preview-pr-1",
						isDefault: false,
						parentId: "br-prod",
					},
				},
				{
					branch: {
						id: "br-p2",
						name: "preview-pr-2",
						isDefault: false,
						parentId: "br-prod",
					},
				},
			],
		});
		const config = defineConfig({
			project: { name: "my-app" },
			branches: { production: {} },
			branchBlueprints: {
				preview: {
					pattern: "preview-*",
					ttl: "1h",
					computeSettings: { autoscalingLimitMaxCu: 1 },
				},
			},
		});
		const result = await pushConfig(config, { api, projectId });
		expect(result.skippedWildcardBranches).toEqual([
			{
				pattern: "preview-*",
				branches: ["preview-pr-1", "preview-pr-2"],
			},
		]);
		// No mutation history beyond the listing calls.
		const mutations = api.history.filter((h) =>
			["updateEndpoint", "updateBranch", "createBranch"].includes(
				h.method,
			),
		);
		expect(mutations).toHaveLength(0);
	});

	test("with applyExisting:true, applies blueprint to every matching existing branch", async () => {
		const api = new FakeNeonApi();
		const projectId = "proj-w2";
		api.seedProject({
			project: {
				id: projectId,
				name: "my-app",
				regionId: "aws-us-east-1",
				pgVersion: 17,
			},
			branches: [
				{
					branch: {
						id: "br-prod",
						name: "production",
						isDefault: true,
					},
				},
				{
					branch: {
						id: "br-p1",
						name: "preview-pr-1",
						isDefault: false,
						parentId: "br-prod",
					},
				},
			],
		});
		const config = defineConfig({
			project: { name: "my-app" },
			branches: { production: {} },
			branchBlueprints: {
				preview: {
					pattern: "preview-*",
					ttl: "1h",
					computeSettings: { autoscalingLimitMaxCu: 1 },
				},
			},
		});
		const result = await pushConfig(config, {
			api,
			projectId,
			applyExisting: true,
		});
		expect(result.skippedWildcardBranches).toHaveLength(0);
		const ops = api.history.filter(
			(h) => h.method === "updateEndpoint" || h.method === "updateBranch",
		);
		expect(ops.map((o) => o.method).sort()).toEqual([
			"updateBranch",
			"updateEndpoint",
		]);
	});
});

describe("pushConfig — overloads & file loading", () => {
	test("pushConfig() auto-loads neon.ts from cwd", async () => {
		const { api, projectId } = seededFake();
		const platformSrcPath = new URL("../v1.ts", import.meta.url).pathname;
		const root = setup({
			"package.json": "{}",
			".neon/project.json": JSON.stringify({ projectId }),
			"neon.ts": `
import { defineConfig } from "${platformSrcPath}";
export default defineConfig({
  project: { name: "my-app", region: "aws-us-east-1" },
  branches: {
    production: {},
    staging: { parent: "production" },
  },
});
`,
		});
		const result = await pushConfig({ api, cwd: root });
		expect(result.applied).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					kind: "branch",
					action: "create",
					identifier: "staging",
				}),
			]),
		);
	});

	test("pushConfig({ configPath }) honours an explicit config path", async () => {
		const { api, projectId } = seededFake();
		const platformSrcPath = new URL("../v1.ts", import.meta.url).pathname;
		const root = setup({
			"package.json": "{}",
			"configs/neon.config.ts": `
import { defineConfig } from "${platformSrcPath}";
export default defineConfig({
  project: { name: "my-app", region: "aws-us-east-1" },
  branches: { production: {} },
});
`,
		});
		const result = await pushConfig({
			api,
			projectId,
			cwd: root,
			configPath: `${root}/configs/neon.config.ts`,
		});
		expect(result.projectId).toBe(projectId);
	});
});
