import { afterEach, describe, expect, test } from "vitest";
import { defineConfig } from "./define-config.js";
import { ErrorCode, PlatformError } from "./errors.js";
import { FakeNeonApi } from "./fake-neon-api.js";
import { loadEnv } from "./load-env.js";
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

function seedSingleBranch(projectId = "proj-env-1") {
	const api = new FakeNeonApi();
	api.seedProject({
		project: {
			id: projectId,
			name: "my-app",
			regionId: "aws-us-east-1",
			pgVersion: 17,
		},
		branches: [
			{
				branch: { id: "br-prod", name: "production", isDefault: true },
			},
		],
	});
	return { api, projectId };
}

const minimalConfig = defineConfig({
	project: { name: "my-app", region: "aws-us-east-1" },
	branches: { production: {} },
});

describe("loadEnv — happy path", () => {
	test("returns env.postgres.databaseUrl + databaseUrlUnpooled for the resolved branch", async () => {
		const { api, projectId } = seedSingleBranch();
		const env = await loadEnv(minimalConfig, { api, projectId, env: {} });

		// Compile-time check: the shape is fixed and statically known.
		({
			databaseUrl: env.postgres.databaseUrl,
			databaseUrlUnpooled: env.postgres.databaseUrlUnpooled,
		}) satisfies { databaseUrl: string; databaseUrlUnpooled: string };

		expect(Object.keys(env)).toEqual(["postgres"]);
		expect(Object.keys(env.postgres).sort()).toEqual([
			"databaseUrl",
			"databaseUrlUnpooled",
		]);
		expect(env.postgres.databaseUrl).toMatch(/^postgresql:\/\//);
		expect(env.postgres.databaseUrl).toContain("-pooler");
		expect(env.postgres.databaseUrlUnpooled).toMatch(/^postgresql:\/\//);
		expect(env.postgres.databaseUrlUnpooled).not.toContain("-pooler");

		// Both URIs hit the same database + role.
		const url = new URL(env.postgres.databaseUrl);
		const unpooledUrl = new URL(env.postgres.databaseUrlUnpooled);
		expect(url.username).toBe("neondb_owner");
		expect(unpooledUrl.username).toBe("neondb_owner");
		expect(url.pathname).toBe("/neondb");
		expect(unpooledUrl.pathname).toBe("/neondb");
	});

	test("resolves project id from .neon/project.json when not passed", async () => {
		const { api, projectId } = seedSingleBranch("proj-from-file");
		const root = setup({
			"package.json": "{}",
			".neon/project.json": JSON.stringify({ projectId }),
		});
		const env = await loadEnv(minimalConfig, { api, cwd: root, env: {} });
		expect(env.postgres.databaseUrl).toContain("br-prod");
	});

	test("resolves project id from NEON_PROJECT_ID env", async () => {
		const { api, projectId } = seedSingleBranch("proj-from-env");
		const env = await loadEnv(minimalConfig, {
			api,
			env: { NEON_PROJECT_ID: projectId },
		});
		expect(env.postgres.databaseUrl).toContain("br-prod");
	});

	test("resolves branch by NEON_BRANCH_ID and uses it over the blueprint key", async () => {
		const api = new FakeNeonApi();
		api.seedProject({
			project: {
				id: "proj-multi",
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
						id: "br-preview",
						name: "preview-pr-42",
						isDefault: false,
						parentId: "br-prod",
					},
				},
			],
		});

		const env = await loadEnv(minimalConfig, {
			api,
			projectId: "proj-multi",
			env: { NEON_BRANCH_ID: "br-preview" },
		});
		expect(env.postgres.databaseUrl).toContain("br-preview");
	});

	test("resolves branch by name from options.branch", async () => {
		const api = new FakeNeonApi();
		api.seedProject({
			project: {
				id: "proj-named",
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
						id: "br-pr-9",
						name: "preview-pr-9",
						isDefault: false,
						parentId: "br-prod",
					},
				},
			],
		});

		const env = await loadEnv(minimalConfig, {
			api,
			projectId: "proj-named",
			branch: "preview-pr-9",
			env: {},
		});
		expect(env.postgres.databaseUrl).toContain("br-pr-9");
	});

	test("falls back to first blueprint key when no branch in args/env/file", async () => {
		const api = new FakeNeonApi();
		api.seedProject({
			project: {
				id: "proj-fallback",
				name: "my-app",
				regionId: "aws-us-east-1",
				pgVersion: 17,
			},
			branches: [
				{
					branch: { id: "br-stg", name: "staging", isDefault: true },
				},
				{
					branch: {
						id: "br-prd",
						name: "production",
						isDefault: false,
					},
				},
			],
		});

		// First key in blueprints is "production"; we expect it to win over isDefault.
		const env = await loadEnv(minimalConfig, {
			api,
			projectId: "proj-fallback",
			env: {},
		});
		expect(env.postgres.databaseUrl).toContain("br-prd");
	});

	test("falls back to default branch when neither blueprint key nor env match", async () => {
		const api = new FakeNeonApi();
		api.seedProject({
			project: {
				id: "proj-nokey",
				name: "my-app",
				regionId: "aws-us-east-1",
				pgVersion: 17,
			},
			branches: [
				{
					branch: {
						id: "br-main",
						name: "main",
						isDefault: true,
					},
				},
			],
		});

		const config = defineConfig({
			project: { name: "my-app", region: "aws-us-east-1" },
			// No blueprints — should fall through to project's default branch.
		});
		const env = await loadEnv(config, {
			api,
			projectId: "proj-nokey",
			env: {},
		});
		expect(env.postgres.databaseUrl).toContain("br-main");
	});
});

describe("loadEnv — error paths", () => {
	test("missing API key without injected api → PlatformError(MissingApiKey)", async () => {
		const emptyHome = setup({ ".config/neonctl/.keep": "" });
		await expect(
			loadEnv(minimalConfig, {
				projectId: "proj-x",
				env: { HOME: emptyHome, USERPROFILE: emptyHome },
			}),
		).rejects.toMatchObject({
			code: ErrorCode.MissingApiKey,
		});
	});

	test("missing context (no projectId resolvable) → MissingContextError", async () => {
		const { api } = seedSingleBranch();
		const root = setup({ "package.json": "{}" });
		await expect(
			loadEnv(minimalConfig, { api, cwd: root, env: {} }),
		).rejects.toMatchObject({
			code: ErrorCode.MissingContext,
		});
	});

	test("project has no branches → PlatformError(BranchNotFound)", async () => {
		const api = new FakeNeonApi();
		// Seed a project then drop its branches by re-seeding via direct private state isn't
		// available — instead, seed with a single branch and look up a non-existent branch id.
		api.seedProject({
			project: {
				id: "proj-empty",
				name: "my-app",
				regionId: "aws-us-east-1",
				pgVersion: 17,
			},
		});
		await expect(
			loadEnv(minimalConfig, {
				api,
				projectId: "proj-empty",
				branch: "br-doesnt-exist",
				env: {},
			}),
		).rejects.toMatchObject({
			code: ErrorCode.BranchNotFound,
		});
	});

	test("requested role not present on branch → PlatformError(BranchNotFound)", async () => {
		const { api, projectId } = seedSingleBranch();
		await expect(
			loadEnv(minimalConfig, {
				api,
				projectId,
				roleName: "nope_owner",
				env: {},
			}),
		).rejects.toMatchObject({
			code: ErrorCode.BranchNotFound,
		});
	});

	test("multiple roles + no explicit roleName → AmbiguousBranchAuth", async () => {
		const api = new FakeNeonApi();
		api.seedProject({
			project: {
				id: "proj-multi-role",
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
					roles: [{ name: "neondb_owner" }, { name: "app_user" }],
				},
			],
		});

		await expect(
			loadEnv(minimalConfig, {
				api,
				projectId: "proj-multi-role",
				env: {},
			}),
		).rejects.toMatchObject({
			code: ErrorCode.AmbiguousBranchAuth,
		});
	});

	test("multiple databases + no explicit databaseName → AmbiguousBranchAuth (when none owned by role)", async () => {
		const api = new FakeNeonApi();
		api.seedProject({
			project: {
				id: "proj-multi-db",
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
					roles: [{ name: "neondb_owner" }],
					databases: [
						{ name: "app_db", ownerName: "someone_else" },
						{ name: "analytics", ownerName: "someone_else" },
					],
				},
			],
		});

		await expect(
			loadEnv(minimalConfig, {
				api,
				projectId: "proj-multi-db",
				env: {},
			}),
		).rejects.toMatchObject({
			code: ErrorCode.AmbiguousBranchAuth,
		});
	});

	test("multiple databases but only one owned by role → auto-pick the owned one", async () => {
		const api = new FakeNeonApi();
		api.seedProject({
			project: {
				id: "proj-owned",
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
					roles: [{ name: "neondb_owner" }],
					databases: [
						{ name: "neondb", ownerName: "neondb_owner" },
						{ name: "shadow", ownerName: "system_role" },
					],
				},
			],
		});

		const env = await loadEnv(minimalConfig, {
			api,
			projectId: "proj-owned",
			env: {},
		});
		expect(env.postgres.databaseUrl).toContain("/neondb?");
	});
});

describe("loadEnv — passes correct arguments to NeonApi", () => {
	test("calls getConnectionUri twice with pooled=true and pooled=false", async () => {
		const { api, projectId } = seedSingleBranch();
		await loadEnv(minimalConfig, { api, projectId, env: {} });
		const calls = api.history.filter(
			(h) => h.method === "getConnectionUri",
		);
		expect(calls).toHaveLength(2);
		const pooled = calls.find(
			(c) => (c.args[1] as { pooled?: boolean }).pooled === true,
		);
		const direct = calls.find(
			(c) =>
				(c.args[1] as { pooled?: boolean }).pooled === undefined ||
				(c.args[1] as { pooled?: boolean }).pooled === false,
		);
		expect(pooled).toBeDefined();
		expect(direct).toBeDefined();
	});

	test("explicit roleName / databaseName are passed through verbatim", async () => {
		const api = new FakeNeonApi();
		api.seedProject({
			project: {
				id: "proj-explicit",
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
					roles: [{ name: "neondb_owner" }, { name: "app_user" }],
					databases: [
						{ name: "neondb", ownerName: "neondb_owner" },
						{ name: "app", ownerName: "app_user" },
					],
				},
			],
		});

		const env = await loadEnv(minimalConfig, {
			api,
			projectId: "proj-explicit",
			roleName: "app_user",
			databaseName: "app",
			env: {},
		});
		expect(env.postgres.databaseUrl).toContain("/app?");
		const url = new URL(env.postgres.databaseUrl);
		expect(url.username).toBe("app_user");
	});

	test("PlatformError surfaced from API is preserved", async () => {
		class FailingApi extends FakeNeonApi {
			override async listBranches(): Promise<never> {
				throw new PlatformError(ErrorCode.Unauthorized, "boom");
			}
		}
		const api = new FailingApi();
		api.seedProject({
			project: {
				id: "proj-x",
				name: "my-app",
				regionId: "aws-us-east-1",
				pgVersion: 17,
			},
		});

		await expect(
			loadEnv(minimalConfig, {
				api,
				projectId: "proj-x",
				env: {},
			}),
		).rejects.toMatchObject({ code: ErrorCode.Unauthorized });
	});
});
