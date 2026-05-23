import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { defineConfig } from "./define-config.js";
import { fetchEnv, parseEnv } from "./env.js";
import { ErrorCode, PlatformError } from "./errors.js";
import { FakeNeonApi } from "./fake-neon-api.js";
import { makeTempRepo, stubCleanNeonEnv } from "./test-utils.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
	while (cleanups.length > 0) cleanups.shift()?.();
});

beforeEach(() => {
	stubCleanNeonEnv();
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

describe("fetchEnv — happy path", () => {
	test("returns env.postgres.databaseUrl + databaseUrlUnpooled for the resolved branch", async () => {
		const { api, projectId } = seedSingleBranch();
		const env = await fetchEnv(minimalConfig, { api, projectId });

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
		const env = await fetchEnv(minimalConfig, { api, cwd: root });
		expect(env.postgres.databaseUrl).toContain("br-prod");
	});

	test("resolves project id from NEON_PROJECT_ID env", async () => {
		const { api, projectId } = seedSingleBranch("proj-from-env");
		vi.stubEnv("NEON_PROJECT_ID", projectId);
		const env = await fetchEnv(minimalConfig, { api });
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
		vi.stubEnv("NEON_BRANCH_ID", "br-preview");

		const env = await fetchEnv(minimalConfig, {
			api,
			projectId: "proj-multi",
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

		const env = await fetchEnv(minimalConfig, {
			api,
			projectId: "proj-named",
			branch: "preview-pr-9",
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
		const env = await fetchEnv(minimalConfig, {
			api,
			projectId: "proj-fallback",
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
		const env = await fetchEnv(config, {
			api,
			projectId: "proj-nokey",
		});
		expect(env.postgres.databaseUrl).toContain("br-main");
	});
});

describe("fetchEnv — error paths", () => {
	test("missing API key without injected api → PlatformError(MissingApiKey)", async () => {
		const emptyHome = setup({ ".config/neonctl/.keep": "" });
		vi.stubEnv("HOME", emptyHome);
		vi.stubEnv("USERPROFILE", emptyHome);
		await expect(
			fetchEnv(minimalConfig, { projectId: "proj-x" }),
		).rejects.toMatchObject({
			code: ErrorCode.MissingApiKey,
		});
	});

	test("missing context (no projectId resolvable) → MissingContextError", async () => {
		const { api } = seedSingleBranch();
		const root = setup({ "package.json": "{}" });
		await expect(
			fetchEnv(minimalConfig, { api, cwd: root }),
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
			fetchEnv(minimalConfig, {
				api,
				projectId: "proj-empty",
				branch: "br-doesnt-exist",
			}),
		).rejects.toMatchObject({
			code: ErrorCode.BranchNotFound,
		});
	});

	test("requested role not present on branch → PlatformError(BranchNotFound)", async () => {
		const { api, projectId } = seedSingleBranch();
		await expect(
			fetchEnv(minimalConfig, {
				api,
				projectId,
				roleName: "nope_owner",
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
			fetchEnv(minimalConfig, {
				api,
				projectId: "proj-multi-role",
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
			fetchEnv(minimalConfig, {
				api,
				projectId: "proj-multi-db",
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

		const env = await fetchEnv(minimalConfig, {
			api,
			projectId: "proj-owned",
		});
		expect(env.postgres.databaseUrl).toContain("/neondb?");
	});
});

describe("fetchEnv — passes correct arguments to NeonApi", () => {
	test("calls getConnectionUri twice with pooled=true and pooled=false", async () => {
		const { api, projectId } = seedSingleBranch();
		await fetchEnv(minimalConfig, { api, projectId });
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

		const env = await fetchEnv(minimalConfig, {
			api,
			projectId: "proj-explicit",
			roleName: "app_user",
			databaseName: "app",
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
			fetchEnv(minimalConfig, {
				api,
				projectId: "proj-x",
			}),
		).rejects.toMatchObject({ code: ErrorCode.Unauthorized });
	});
});

describe("parseEnv", () => {
	test("returns the NeonEnv shape from process.env", () => {
		vi.stubEnv("DATABASE_URL", "postgres://pooled.example/db");
		vi.stubEnv("DATABASE_URL_UNPOOLED", "postgres://direct.example/db");
		const env = parseEnv(minimalConfig);
		expect(env).toEqual({
			postgres: {
				databaseUrl: "postgres://pooled.example/db",
				databaseUrlUnpooled: "postgres://direct.example/db",
			},
		});
		// Compile-time check: shape is statically known, no Record<string, string> widening.
		({
			databaseUrl: env.postgres.databaseUrl,
			databaseUrlUnpooled: env.postgres.databaseUrlUnpooled,
		}) satisfies { databaseUrl: string; databaseUrlUnpooled: string };
	});

	test("throws EnvNotInjected when both vars are missing", () => {
		expect(() => parseEnv(minimalConfig)).toThrow(PlatformError);
		try {
			parseEnv(minimalConfig);
		} catch (err) {
			expect(err).toBeInstanceOf(PlatformError);
			const e = err as PlatformError;
			expect(e.code).toBe(ErrorCode.EnvNotInjected);
			expect(e.message).toContain("DATABASE_URL is missing");
			expect(e.message).toContain("DATABASE_URL_UNPOOLED is missing");
			expect(e.message).toContain("neon-ts env pull");
			expect(e.message).toContain("neon-ts env run");
		}
	});

	test("throws EnvNotInjected when only one is set", () => {
		vi.stubEnv("DATABASE_URL", "postgres://pooled");
		expect(() => parseEnv(minimalConfig)).toThrow(
			/DATABASE_URL_UNPOOLED is missing/,
		);
	});

	test("rejects empty-string values (e.g. unset .env entries)", () => {
		vi.stubEnv("DATABASE_URL", "");
		vi.stubEnv("DATABASE_URL_UNPOOLED", "postgres://direct");
		expect(() => parseEnv(minimalConfig)).toThrow(/must not be empty/);
	});
});

describe("parseEnv — features-driven shape", () => {
	const authConfig = defineConfig({
		project: { name: "my-app", region: "aws-us-east-1" },
		branches: { production: {} },
		features: { auth: true },
	});
	const dataApiConfig = defineConfig({
		project: { name: "my-app", region: "aws-us-east-1" },
		branches: { production: {} },
		features: { dataApi: true },
	});
	const bothConfig = defineConfig({
		project: { name: "my-app", region: "aws-us-east-1" },
		branches: { production: {} },
		features: { auth: true, dataApi: true },
	});

	function stubFullEnv(): void {
		vi.stubEnv("DATABASE_URL", "postgres://pooled/db");
		vi.stubEnv("DATABASE_URL_UNPOOLED", "postgres://direct/db");
		vi.stubEnv("NEON_AUTH_PROJECT_ID", "stack-proj-x");
		vi.stubEnv("NEON_AUTH_PUBLISHABLE_CLIENT_KEY", "pck_test");
		vi.stubEnv("NEON_AUTH_SECRET_SERVER_KEY", "ssk_test");
		vi.stubEnv(
			"NEON_AUTH_JWKS_URL",
			"https://auth.example/.well-known/jwks.json",
		);
		vi.stubEnv("NEON_DATA_API_URL", "https://dataapi.example");
	}

	test("with features.auth=true: parses auth env vars and types env.auth", () => {
		stubFullEnv();
		const env = parseEnv(authConfig);
		expect(env.auth).toEqual({
			projectId: "stack-proj-x",
			publishableClientKey: "pck_test",
			secretServerKey: "ssk_test",
			jwksUrl: "https://auth.example/.well-known/jwks.json",
		});
		// Compile-time check: env.auth exists in the static type when features.auth: true.
		({ projectId: env.auth.projectId }) satisfies { projectId: string };
	});

	test("with features.dataApi=true: parses dataApi env vars and types env.dataApi", () => {
		stubFullEnv();
		const env = parseEnv(dataApiConfig);
		expect(env.dataApi).toEqual({ url: "https://dataapi.example" });
	});

	test("with both features enabled: both namespaces are populated", () => {
		stubFullEnv();
		const env = parseEnv(bothConfig);
		expect(env.postgres).toBeDefined();
		expect(env.auth).toBeDefined();
		expect(env.dataApi).toBeDefined();
	});

	test("missing auth secret server key throws EnvNotInjected when features.auth is true", () => {
		stubFullEnv();
		vi.stubEnv("NEON_AUTH_SECRET_SERVER_KEY", undefined);
		expect(() => parseEnv(authConfig)).toThrow(
			/NEON_AUTH_SECRET_SERVER_KEY is missing/,
		);
	});

	test("a disabled feature does NOT require its env vars to be present", () => {
		// Stub only the Postgres vars; the (missing) NEON_AUTH_* keys are irrelevant
		// because `minimalConfig` doesn't enable auth.
		vi.stubEnv("DATABASE_URL", "postgres://pooled");
		vi.stubEnv("DATABASE_URL_UNPOOLED", "postgres://direct");
		const env = parseEnv(minimalConfig);
		expect(env.postgres.databaseUrl).toBe("postgres://pooled");
		// Compile-time check: env.auth must be a type error when features.auth is unset.
		// @ts-expect-error — env.auth is not in the type when features.auth is false
		void env.auth;
	});

	test("aggregates every missing var across namespaces into one error", () => {
		// Only DATABASE_URL set; every other namespace's required var is missing.
		vi.stubEnv("DATABASE_URL", "postgres://pooled");
		try {
			parseEnv(bothConfig);
			expect.fail("should have thrown");
		} catch (err) {
			expect(err).toBeInstanceOf(PlatformError);
			const message = (err as PlatformError).message;
			expect(message).toContain("DATABASE_URL_UNPOOLED is missing");
			expect(message).toContain("NEON_AUTH_PROJECT_ID is missing");
			expect(message).toContain(
				"NEON_AUTH_PUBLISHABLE_CLIENT_KEY is missing",
			);
			expect(message).toContain("NEON_AUTH_SECRET_SERVER_KEY is missing");
			expect(message).toContain("NEON_AUTH_JWKS_URL is missing");
			expect(message).toContain("NEON_DATA_API_URL is missing");
		}
	});
});

describe("fetchEnv — features-driven shape", () => {
	function seedWithFeatures(): { api: FakeNeonApi; projectId: string } {
		const api = new FakeNeonApi();
		const projectId = "proj-features";
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
			],
		});
		api.seedNeonAuth(projectId, "br-prod", {
			projectId: "stack-proj-x",
			jwksUrl: "https://auth.example/.well-known/jwks.json",
		});
		api.seedNeonDataApi(projectId, "br-prod", "neondb", {
			url: "https://dataapi.example",
		});
		return { api, projectId };
	}

	test("populates env.auth from getNeonAuth + injected secrets", async () => {
		const { api, projectId } = seedWithFeatures();
		const config = defineConfig({
			project: { name: "my-app", region: "aws-us-east-1" },
			branches: { production: {} },
			features: { auth: true },
		});
		vi.stubEnv("NEON_AUTH_PUBLISHABLE_CLIENT_KEY", "pck_test");
		vi.stubEnv("NEON_AUTH_SECRET_SERVER_KEY", "ssk_test");
		const env = await fetchEnv(config, { api, projectId });
		expect(env.auth).toEqual({
			projectId: "stack-proj-x",
			publishableClientKey: "pck_test",
			secretServerKey: "ssk_test",
			jwksUrl: "https://auth.example/.well-known/jwks.json",
		});
	});

	test("populates env.dataApi from getNeonDataApi", async () => {
		const { api, projectId } = seedWithFeatures();
		const config = defineConfig({
			project: { name: "my-app", region: "aws-us-east-1" },
			branches: { production: {} },
			features: { dataApi: true },
		});
		const env = await fetchEnv(config, { api, projectId });
		expect(env.dataApi).toEqual({ url: "https://dataapi.example" });
	});

	test("throws EnvNotInjected when features.auth is true but secrets aren't in env", async () => {
		const { api, projectId } = seedWithFeatures();
		const config = defineConfig({
			project: { name: "my-app", region: "aws-us-east-1" },
			branches: { production: {} },
			features: { auth: true },
		});
		await expect(
			fetchEnv(config, { api, projectId }),
		).rejects.toMatchObject({ code: ErrorCode.EnvNotInjected });
	});

	test("throws NotFound when features.auth=true but no integration exists on the branch", async () => {
		const api = new FakeNeonApi();
		const projectId = "proj-no-auth";
		api.seedProject({
			project: {
				id: projectId,
				name: "my-app",
				regionId: "aws-us-east-1",
				pgVersion: 17,
			},
		});
		const config = defineConfig({
			project: { name: "my-app", region: "aws-us-east-1" },
			branches: { production: {} },
			features: { auth: true },
		});
		vi.stubEnv("NEON_AUTH_PUBLISHABLE_CLIENT_KEY", "pck");
		vi.stubEnv("NEON_AUTH_SECRET_SERVER_KEY", "ssk");
		await expect(
			fetchEnv(config, { api, projectId }),
		).rejects.toMatchObject({ code: ErrorCode.NotFound });
	});

	test("skips getNeonAuth / getNeonDataApi when features are disabled", async () => {
		const { api, projectId } = seedWithFeatures();
		await fetchEnv(minimalConfig, { api, projectId });
		const integrationCalls = api.history.filter(
			(h) => h.method === "getNeonAuth" || h.method === "getNeonDataApi",
		);
		expect(integrationCalls).toHaveLength(0);
	});
});
