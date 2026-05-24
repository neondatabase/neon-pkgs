import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { defineConfig } from "./define-config.js";
import { MissingContextError, PushConflictError } from "./errors.js";
import { FakeNeonApi } from "./fake-neon-api.js";
import { pushConfig } from "./push-config.js";
import { makeTempRepo, stubCleanNeonEnv } from "./test-utils.js";

beforeEach(() => {
	stubCleanNeonEnv();
});

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

	test("throws MissingContextError when no projectId / NEON_PROJECT_ID / context file is resolvable", async () => {
		const api = new FakeNeonApi();
		const config = defineConfig({
			project: { name: "my-app", region: "aws-us-east-1" },
			branches: { production: {} },
		});
		// `cwd` points at a fresh temp repo with no `.neon` context file. The error
		// message must tell the user how to bootstrap with neonctl link rather than
		// implying push will create one for them.
		const root = setup({ "package.json": "{}" });
		await expect(
			pushConfig(config, { api, cwd: root }),
		).rejects.toBeInstanceOf(MissingContextError);
		await expect(pushConfig(config, { api, cwd: root })).rejects.toThrow(
			/neonctl link/,
		);
		// And we never called the create API.
		expect(api.history.some((h) => h.method === "createProject")).toBe(
			false,
		);
	});

	test("fails on missing project context before loading neon.ts", async () => {
		const api = new FakeNeonApi();
		const root = setup({ "package.json": "{}" });
		await expect(
			pushConfig({
				api,
				cwd: root,
				configPath: "does-not-exist.ts",
			}),
		).rejects.toBeInstanceOf(MissingContextError);
		expect(api.history).toHaveLength(0);
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

	test("works with a project-scoped key flow: getProject is the only project call", async () => {
		// Simulate a project-scoped key by giving the fake api a listProjects implementation
		// that throws 403. The push must succeed because the new resolveProject path only
		// calls getProject — listProjects (the lookup-by-name path) was removed alongside
		// project auto-create.
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

	test("with updateExisting:true, applies branch-level drift instead of failing", async () => {
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
		const branches = await api.listBranches(projectId);
		const prodBranchId = branches.find((b) => b.name === "production")?.id;
		const endpoints = await api.listEndpoints(projectId);
		const prodEndpoint = endpoints.find((e) => e.branchId === prodBranchId);
		expect(prodEndpoint?.autoscalingLimitMaxCu).toBe(4);
	});

	test("with updateExisting:true, renames the project when names differ", async () => {
		const { api, projectId } = seededFake();
		const config = defineConfig({
			project: { name: "renamed-app", region: "aws-us-east-1" },
		});
		const result = await pushConfig(config, {
			api,
			projectId,
			updateExisting: true,
		});
		expect(result.conflicts).toHaveLength(0);
		expect(result.applied).toEqual([
			expect.objectContaining({
				kind: "project",
				action: "update",
				identifier: projectId,
				details: { from: "my-app", to: "renamed-app" },
			}),
		]);
		const refreshed = await api.getProject(projectId);
		expect(refreshed.name).toBe("renamed-app");
	});

	test("region conflicts always throw, even with updateExisting:true (immutable)", async () => {
		const { api, projectId } = seededFake();
		const config = defineConfig({
			project: { name: "my-app", region: "aws-eu-central-1" },
		});
		await expect(
			pushConfig(config, { api, projectId, updateExisting: true }),
		).rejects.toThrow(PushConflictError);
	});

	test("pgVersion conflicts always throw, even with updateExisting:true (immutable)", async () => {
		const { api, projectId } = seededFake();
		const config = defineConfig({
			project: { name: "my-app", pgVersion: 15 },
		});
		await expect(
			pushConfig(config, { api, projectId, updateExisting: true }),
		).rejects.toThrow(PushConflictError);
	});
});

describe("pushConfig — wildcard blueprints are creation-only", () => {
	test("matching live branches are left completely untouched by push", async () => {
		// Blueprints exist solely to mint ephemeral branches via `branch()`.
		// `pushConfig` deliberately never touches branches matched by a wildcard —
		// even with `updateExisting: true`, even when settings drift wildly.
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
		const result = await pushConfig(config, {
			api,
			projectId,
			updateExisting: true,
		});
		expect(result.conflicts).toHaveLength(0);
		const mutations = api.history.filter((h) =>
			["updateEndpoint", "updateBranch", "createBranch"].includes(
				h.method,
			),
		);
		expect(mutations).toHaveLength(0);
	});
});

describe("pushConfig — dry-run", () => {
	test("returns dryRun:true and never calls a mutating API method", async () => {
		const { api, projectId } = seededFake();
		const config = defineConfig({
			project: { name: "my-app" },
			branches: {
				production: {},
				staging: { parent: "production" },
			},
		});
		const result = await pushConfig(config, {
			api,
			projectId,
			dryRun: true,
		});
		expect(result.dryRun).toBe(true);
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
		const mutating = api.history.filter((h) =>
			[
				"createBranch",
				"updateBranch",
				"updateEndpoint",
				"createProject",
				"updateProject",
			].includes(h.method),
		);
		expect(mutating).toHaveLength(0);
	});

	test("dryRun reports conflicts without throwing", async () => {
		const { api, projectId } = seededFake();
		const config = defineConfig({
			project: { name: "my-app", region: "aws-eu-central-1" },
			branches: { production: {} },
		});
		// Region drift would throw on a real push; dry-run must surface it cleanly.
		const result = await pushConfig(config, {
			api,
			projectId,
			dryRun: true,
		});
		expect(result.dryRun).toBe(true);
		expect(result.conflicts).toContainEqual(
			expect.objectContaining({ kind: "project", field: "region" }),
		);
	});

	test("dryRun: rename-project step shows up in `applied` without calling updateProject", async () => {
		const { api, projectId } = seededFake();
		const config = defineConfig({
			project: { name: "renamed-app" },
		});
		const result = await pushConfig(config, {
			api,
			projectId,
			dryRun: true,
			updateExisting: true,
		});
		expect(result.dryRun).toBe(true);
		expect(result.applied).toEqual([
			expect.objectContaining({
				kind: "project",
				action: "update",
				identifier: projectId,
				details: { from: "my-app", to: "renamed-app" },
			}),
		]);
		expect(api.history.some((h) => h.method === "updateProject")).toBe(
			false,
		);
	});
});

describe("pushConfig — features (auth / dataApi)", () => {
	test("enables Neon Auth on the root branch when features.auth=true", async () => {
		const { api, projectId } = seededFake();
		const config = defineConfig({
			project: { name: "my-app" },
			branches: { production: {} },
			features: { auth: true },
		});
		const result = await pushConfig(config, { api, projectId });
		expect(result.applied).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					kind: "feature",
					action: "create",
					identifier: "auth",
				}),
			]),
		);
		// Idempotent: a second push reports no feature change.
		const second = await pushConfig(config, { api, projectId });
		expect(second.applied.filter((a) => a.kind === "feature")).toHaveLength(
			0,
		);
	});

	test("enables Data API on the root branch with the auto-picked database", async () => {
		const { api, projectId } = seededFake();
		const config = defineConfig({
			project: { name: "my-app" },
			branches: { production: {} },
			features: { dataApi: true },
		});
		const result = await pushConfig(config, { api, projectId });
		expect(result.applied).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					kind: "feature",
					action: "create",
					identifier: "dataApi",
					details: expect.objectContaining({
						branchName: "production",
						databaseName: "neondb",
					}),
				}),
			]),
		);
	});

	test("dryRun: features that need enabling are reported but no API mutations run", async () => {
		const { api, projectId } = seededFake();
		const config = defineConfig({
			project: { name: "my-app" },
			branches: { production: {} },
			features: { auth: true, dataApi: true },
		});
		const result = await pushConfig(config, {
			api,
			projectId,
			dryRun: true,
		});
		expect(result.dryRun).toBe(true);
		const featureChanges = result.applied.filter(
			(a) => a.kind === "feature",
		);
		expect(featureChanges.map((c) => c.identifier).sort()).toEqual([
			"auth",
			"dataApi",
		]);
		expect(
			api.history.some(
				(h) =>
					h.method === "enableNeonAuth" ||
					h.method === "enableProjectBranchDataApi",
			),
		).toBe(false);
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
