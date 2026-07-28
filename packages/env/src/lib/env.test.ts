import {
	defineConfig,
	ErrorCode,
	type GetConnectionUriInput,
} from "@neon/config/v1";
import { beforeEach, describe, expect, test, vi } from "vitest";
import {
	type CredentialResolution,
	fetchEnv,
	type NeonAuthEnv,
	type NeonEnv,
	parseEnv,
	toEntries,
} from "./env.js";
import { FakeNeonApi } from "./fake-neon-api.js";
import { stubCleanNeonEnv } from "./test-utils.js";

beforeEach(() => stubCleanNeonEnv());

function expectType<T>(_value: T): void {
	// Compile-time assertion only.
}

function seededFake() {
	const api = new FakeNeonApi();
	const projectId = "proj-env";
	api.seedProject({
		project: {
			id: projectId,
			name: "env-test",
			regionId: "aws-us-east-1",
			pgVersion: 17,
		},
		branches: [
			{ branch: { id: "br-main", name: "main", isDefault: true } },
		],
	});
	return { api, projectId };
}

/**
 * A {@link FakeNeonApi} whose Postgres connection host carries an infra cell prefix
 * (`<endpoint>.c-3.<region>.…`), mirroring production. The base fake omits the cell, so this
 * is the only way to exercise the gateway host's cell-routing derivation end to end.
 */
class CellHostFakeNeonApi extends FakeNeonApi {
	override async getConnectionUri(
		projectId: string,
		input: GetConnectionUriInput,
	): Promise<{ uri: string }> {
		const { uri } = await super.getConnectionUri(projectId, input);
		const url = new URL(uri);
		const [endpointLabel, ...rest] = url.hostname.split(".");
		url.hostname = [endpointLabel, "c-3", ...rest].join(".");
		return { uri: url.toString() };
	}
}

/** Seed a single-branch project whose `main` branch carries the given role names. */
function seededFakeWithRoles(roleNames: string[]) {
	const api = new FakeNeonApi();
	const projectId = "proj-env-roles";
	api.seedProject({
		project: {
			id: projectId,
			name: "env-roles-test",
			regionId: "aws-us-east-1",
			pgVersion: 17,
		},
		branches: [
			{
				branch: { id: "br-main", name: "main", isDefault: true },
				roles: roleNames.map((name) => ({ name })),
			},
		],
	});
	return { api, projectId };
}

function seededFakeWithDatabases(
	databases: Array<{ name: string; ownerName?: string }>,
) {
	const api = new FakeNeonApi();
	const projectId = "proj-env-dbs";
	api.seedProject({
		project: {
			id: projectId,
			name: "env-dbs-test",
			regionId: "aws-us-east-1",
			pgVersion: 17,
		},
		branches: [
			{
				branch: { id: "br-main", name: "main", isDefault: true },
				databases,
			},
		],
	});
	return { api, projectId };
}

describe("fetchEnv", () => {
	test("fetches postgres env for selected branch", async () => {
		const { api, projectId } = seededFake();
		const config = defineConfig({});
		const env = await fetchEnv(config, {
			api,
			projectId,
			branchId: "br-main",
		});
		expect(env.postgres.databaseUrl).toContain("postgresql://");
		expect(env.postgres.databaseUrl).toContain("-pooler");
	});

	test("resolves the branch by name via `branch`", async () => {
		const { api, projectId } = seededFake();
		const env = await fetchEnv(defineConfig({}), {
			api,
			projectId,
			branch: "main",
		});
		expect(env.branch?.name).toBe("main");
		expect(env.postgres.databaseUrl).toContain("postgresql://");
	});

	test("`branch` (id) wins over the legacy `branchId`", async () => {
		const { api, projectId } = seededFake();
		const env = await fetchEnv(defineConfig({}), {
			api,
			projectId,
			branch: "main",
			branchId: "br-does-not-exist",
		});
		expect(env.branch?.name).toBe("main");
	});

	test("throws a clear error for an unknown branch name or id", async () => {
		const { api, projectId } = seededFake();
		await expect(
			fetchEnv(defineConfig({}), { api, projectId, branch: "nope" }),
		).rejects.toMatchObject({ code: ErrorCode.BranchNotFound });
	});

	test("throws when no branch is provided", async () => {
		const { api, projectId } = seededFake();
		await expect(
			fetchEnv(defineConfig({}), { api, projectId }),
		).rejects.toMatchObject({ code: ErrorCode.BranchNotFound });
	});

	test("surfaces the branch name as NEON_BRANCH", async () => {
		const { api, projectId } = seededFake();
		const env = await fetchEnv(defineConfig({}), {
			api,
			projectId,
			branchId: "br-main",
		});
		// `NEON_BRANCH` mirrors the Functions runtime; uses the branch name (not the id).
		expect(env.branch?.name).toBe("main");
		expect(toEntries(env).NEON_BRANCH).toBe("main");
	});

	test("requires auth integration when policy enables auth", async () => {
		const { api, projectId } = seededFake();
		const config = defineConfig({ auth: true });
		await expect(
			fetchEnv(config, { api, projectId, branchId: "br-main" }),
		).rejects.toMatchObject({ code: ErrorCode.NotFound });
	});

	test("returns the integration base URL from the live snapshot", async () => {
		const { api, projectId } = seededFake();
		await api.enableNeonAuth(projectId, "br-main");
		const config = defineConfig({ auth: true });

		const env = await fetchEnv(config, {
			api,
			projectId,
			branchId: "br-main",
		});

		expect(env.auth.baseUrl).toBe(
			`https://api.fake.neon.tech/auth/${projectId}/br-main`,
		);
		expect(env.auth.jwksUrl).toBe(
			`https://api.fake.neon.tech/auth/${projectId}/br-main/.well-known/jwks.json`,
		);
	});

	test("falls back to the supplied env source when the snapshot omits base URL", async () => {
		const { api, projectId } = seededFake();
		api.seedNeonAuth(projectId, "br-main", {
			projectId: "auth-br-main",
			jwksUrl: "https://example.com/jwks.json",
		});
		const config = defineConfig({ auth: true });

		const env = await fetchEnv(config, {
			api,
			projectId,
			branchId: "br-main",
			env: { NEON_AUTH_BASE_URL: "https://auth.example.com" },
		});

		expect(env.auth.baseUrl).toBe("https://auth.example.com");
		// jwks_url is always returned by the snapshot, so it comes from there.
		expect(env.auth.jwksUrl).toBe("https://example.com/jwks.json");
	});

	test("defaults to neondb_owner when Auth/Data API add managed roles", async () => {
		// Enabling auth + dataApi provisions the PostgREST roles next to the owner.
		const { api, projectId } = seededFakeWithRoles([
			"neondb_owner",
			"authenticator",
			"anonymous",
			"authenticated",
		]);
		const env = await fetchEnv(defineConfig({}), {
			api,
			projectId,
			branchId: "br-main",
		});
		expect(env.postgres.databaseUrl).toContain(
			"postgresql://neondb_owner:",
		);
		expect(env.postgres.databaseUrlUnpooled).toContain(
			"postgresql://neondb_owner:",
		);
	});

	test("falls back to the single non-managed role for a custom owner name", async () => {
		const { api, projectId } = seededFakeWithRoles([
			"app_owner",
			"authenticator",
			"anonymous",
			"authenticated",
		]);
		const env = await fetchEnv(defineConfig({}), {
			api,
			projectId,
			branchId: "br-main",
		});
		expect(env.postgres.databaseUrl).toContain("postgresql://app_owner:");
	});

	test("still throws when more than one app role remains", async () => {
		const { api, projectId } = seededFakeWithRoles([
			"owner_a",
			"owner_b",
			"authenticator",
		]);
		await expect(
			fetchEnv(defineConfig({}), { api, projectId, branchId: "br-main" }),
		).rejects.toMatchObject({ code: ErrorCode.AmbiguousBranchAuth });
	});

	test("an explicit roleName still wins over the owner default", async () => {
		const { api, projectId } = seededFakeWithRoles([
			"neondb_owner",
			"authenticator",
		]);
		const env = await fetchEnv(defineConfig({}), {
			api,
			projectId,
			branchId: "br-main",
			roleName: "authenticator",
		});
		expect(env.postgres.databaseUrl).toContain(
			"postgresql://authenticator:",
		);
	});

	test("prefers the default neondb among multiple databases", async () => {
		const { api, projectId } = seededFakeWithDatabases([
			{ name: "my-database" },
			{ name: "neondb" },
		]);
		const env = await fetchEnv(defineConfig({}), {
			api,
			projectId,
			branchId: "br-main",
		});
		expect(env.postgres.databaseUrl).toContain("/neondb?");
	});

	test("uses the sole remaining database when neondb is absent", async () => {
		const { api, projectId } = seededFakeWithDatabases([
			{ name: "my-database" },
		]);
		const env = await fetchEnv(defineConfig({}), {
			api,
			projectId,
			branchId: "br-main",
		});
		expect(env.postgres.databaseUrl).toContain("/my-database?");
	});

	test("throws when several databases and none is neondb", async () => {
		const { api, projectId } = seededFakeWithDatabases([
			{ name: "alpha" },
			{ name: "beta" },
		]);
		await expect(
			fetchEnv(defineConfig({}), { api, projectId, branchId: "br-main" }),
		).rejects.toMatchObject({ code: ErrorCode.AmbiguousBranchAuth });
	});

	test("an explicit databaseName still wins over the auto-pick", async () => {
		const { api, projectId } = seededFakeWithDatabases([
			{ name: "my-database" },
			{ name: "neondb" },
		]);
		const env = await fetchEnv(defineConfig({}), {
			api,
			projectId,
			branchId: "br-main",
			databaseName: "my-database",
		});
		expect(env.postgres.databaseUrl).toContain("/my-database?");
	});
});

describe("parseEnv", () => {
	test("parses postgres env synchronously (external scope)", () => {
		vi.stubEnv("DATABASE_URL", "postgres://pooled");
		vi.stubEnv("DATABASE_URL_UNPOOLED", "postgres://direct");
		const env = parseEnv(defineConfig({}));
		expect(env.postgres.databaseUrl).toBe("postgres://pooled");
	});

	test("reads NEON_BRANCH when injected", () => {
		vi.stubEnv("DATABASE_URL", "postgres://pooled");
		vi.stubEnv("DATABASE_URL_UNPOOLED", "postgres://direct");
		vi.stubEnv("NEON_BRANCH", "preview/foo");
		const env = parseEnv(defineConfig({}));
		expect(env.branch?.name).toBe("preview/foo");
	});

	test("omits the branch namespace when NEON_BRANCH is absent (no throw)", () => {
		vi.stubEnv("DATABASE_URL", "postgres://pooled");
		vi.stubEnv("DATABASE_URL_UNPOOLED", "postgres://direct");
		const env = parseEnv(defineConfig({}));
		expect(env.branch).toBeUndefined();
		expect(env.postgres.databaseUrl).toBe("postgres://pooled");
	});

	test("requires service env when service toggles are statically enabled", () => {
		vi.stubEnv("DATABASE_URL", "postgres://pooled");
		vi.stubEnv("DATABASE_URL_UNPOOLED", "postgres://direct");
		const config = defineConfig({ auth: true, dataApi: true });

		expect(() => parseEnv(config)).toThrow(
			expect.objectContaining({ code: ErrorCode.EnvNotInjected }),
		);
	});

	test("types auth env from the static toggle and excludes dataApi", () => {
		vi.stubEnv("DATABASE_URL", "postgres://pooled");
		vi.stubEnv("DATABASE_URL_UNPOOLED", "postgres://direct");
		vi.stubEnv("NEON_AUTH_BASE_URL", "https://auth.example.com");
		vi.stubEnv("NEON_AUTH_JWKS_URL", "https://auth.example.com/jwks.json");
		const config = defineConfig({ auth: true });

		const env = parseEnv(config);

		expectType<NeonEnv<typeof config>>(env);
		expectType<NeonAuthEnv>(env.auth);
		// @ts-expect-error auth: true must not imply Data API env.
		env.dataApi;
		expect(env.auth.baseUrl).toBe("https://auth.example.com");
		expect(env.auth.jwksUrl).toBe("https://auth.example.com/jwks.json");
	});

	test("rejects an empty NEON_AUTH_BASE_URL value", () => {
		vi.stubEnv("DATABASE_URL", "postgres://pooled");
		vi.stubEnv("DATABASE_URL_UNPOOLED", "postgres://direct");
		vi.stubEnv("NEON_AUTH_BASE_URL", "");
		vi.stubEnv("NEON_AUTH_JWKS_URL", "https://auth.example.com/jwks.json");

		expect(() => parseEnv(defineConfig({ auth: true }))).toThrow(
			expect.objectContaining({ code: ErrorCode.EnvNotInjected }),
		);
	});

	test("rejects a missing NEON_AUTH_JWKS_URL value", () => {
		vi.stubEnv("DATABASE_URL", "postgres://pooled");
		vi.stubEnv("DATABASE_URL_UNPOOLED", "postgres://direct");
		vi.stubEnv("NEON_AUTH_BASE_URL", "https://auth.example.com");
		// NEON_AUTH_JWKS_URL intentionally unset.

		expect(() => parseEnv(defineConfig({ auth: true }))).toThrow(
			expect.objectContaining({ code: ErrorCode.EnvNotInjected }),
		);
	});

	test("a boolean false / object false toggle yields just postgres", () => {
		vi.stubEnv("DATABASE_URL", "postgres://pooled");
		vi.stubEnv("DATABASE_URL_UNPOOLED", "postgres://direct");
		const config = defineConfig({
			auth: false,
			dataApi: { enabled: false },
		});
		const env = parseEnv(config);
		// @ts-expect-error disabled toggles must not add the namespace.
		env.auth;
		expect(env.postgres.databaseUrl).toBe("postgres://pooled");
	});

	describe("function scope", () => {
		const config = defineConfig({
			preview: {
				functions: {
					hello: {
						name: "Hello",
						source: "./hello.ts",
						env: {
							resendApiKey: process.env.NOT_SET ?? "placeholder",
						},
					},
				},
			},
		});

		test("returns the declared function env keys, typed", () => {
			vi.stubEnv("DATABASE_URL", "postgres://pooled");
			vi.stubEnv("DATABASE_URL_UNPOOLED", "postgres://direct");
			vi.stubEnv("resendApiKey", "re_live_123");

			const env = parseEnv(config, "hello");

			expect(env.function.resendApiKey).toBe("re_live_123");
			// @ts-expect-error only declared keys are present on the function namespace.
			env.function.notDeclared;
		});

		test("throws EnvNotInjected when a declared function env key is missing", () => {
			vi.stubEnv("DATABASE_URL", "postgres://pooled");
			vi.stubEnv("DATABASE_URL_UNPOOLED", "postgres://direct");

			expect(() => parseEnv(config, "hello")).toThrow(
				expect.objectContaining({ code: ErrorCode.EnvNotInjected }),
			);
		});

		test("rejects an unknown function slug at the type level", () => {
			vi.stubEnv("DATABASE_URL", "postgres://pooled");
			vi.stubEnv("DATABASE_URL_UNPOOLED", "postgres://direct");
			// @ts-expect-error "nope" is not a declared function slug.
			expect(() => parseEnv(config, "nope")).toThrow();
		});

		test("passes through a deliberately empty function env value (present != non-empty)", () => {
			vi.stubEnv("DATABASE_URL", "postgres://pooled");
			vi.stubEnv("DATABASE_URL_UNPOOLED", "postgres://direct");
			vi.stubEnv("resendApiKey", "");
			const env = parseEnv(config, "hello");
			expect(env.function.resendApiKey).toBe("");
		});

		test("returns an empty function namespace when the function declares no env keys", () => {
			vi.stubEnv("DATABASE_URL", "postgres://pooled");
			vi.stubEnv("DATABASE_URL_UNPOOLED", "postgres://direct");
			const noEnvConfig = defineConfig({
				preview: {
					functions: { bare: { name: "Bare", source: "./bare.ts" } },
				},
			});
			const env = parseEnv(noEnvConfig, "bare");
			expect(env.function).toEqual({});
		});

		test("function scope still includes branch secrets (auth) when enabled", () => {
			vi.stubEnv("DATABASE_URL", "postgres://pooled");
			vi.stubEnv("DATABASE_URL_UNPOOLED", "postgres://direct");
			vi.stubEnv("NEON_AUTH_BASE_URL", "https://auth.example.com");
			vi.stubEnv(
				"NEON_AUTH_JWKS_URL",
				"https://auth.example.com/jwks.json",
			);
			vi.stubEnv("resendApiKey", "re_live_123");
			const authConfig = defineConfig({
				auth: true,
				preview: {
					functions: {
						hello: {
							name: "Hello",
							source: "./hello.ts",
							env: { resendApiKey: "" },
						},
					},
				},
			});
			const env = parseEnv(authConfig, "hello");
			expect(env.auth.baseUrl).toBe("https://auth.example.com");
			expect(env.auth.jwksUrl).toBe("https://auth.example.com/jwks.json");
			expect(env.function.resendApiKey).toBe("re_live_123");
		});
	});

	test("external scope has no function namespace (type-level)", () => {
		vi.stubEnv("DATABASE_URL", "postgres://pooled");
		vi.stubEnv("DATABASE_URL_UNPOOLED", "postgres://direct");
		const env = parseEnv(defineConfig({}));
		// @ts-expect-error external scope must not expose the function namespace.
		env.function;
		expect(env.postgres.databaseUrl).toBe("postgres://pooled");
	});

	test("a present-but-empty object toggle (`auth: {}`) enables the namespace", () => {
		vi.stubEnv("DATABASE_URL", "postgres://pooled");
		vi.stubEnv("DATABASE_URL_UNPOOLED", "postgres://direct");
		vi.stubEnv("NEON_AUTH_BASE_URL", "https://auth.example.com");
		vi.stubEnv("NEON_AUTH_JWKS_URL", "https://auth.example.com/jwks.json");
		const env = parseEnv(defineConfig({ auth: {} }));
		expect(env.auth.baseUrl).toBe("https://auth.example.com");
		expect(env.auth.jwksUrl).toBe("https://auth.example.com/jwks.json");
	});

	test("`dataApi: { enabled: true }` enables the data API namespace", () => {
		vi.stubEnv("DATABASE_URL", "postgres://pooled");
		vi.stubEnv("DATABASE_URL_UNPOOLED", "postgres://direct");
		vi.stubEnv("NEON_DATA_API_URL", "https://data.example.com");
		// `authProvider: "external"` so the toggle stands alone (a `"neon"` Data API
		// requires Neon Auth — covered by the config package's validation tests).
		const env = parseEnv(
			defineConfig({
				dataApi: {
					enabled: true,
					authProvider: "external",
					jwksUrl: "https://idp.example.com/.well-known/jwks.json",
				},
			}),
		);
		expect(env.dataApi.url).toBe("https://data.example.com");
	});

	describe("key filter", () => {
		test("narrows a namespace to only the selected key", () => {
			vi.stubEnv("DATABASE_URL", "postgres://pooled");
			vi.stubEnv("DATABASE_URL_UNPOOLED", "postgres://direct");
			const env = parseEnv(defineConfig({}), ["DATABASE_URL"]);
			expect(env.postgres.databaseUrl).toBe("postgres://pooled");
			// Only the selected key survives — the unpooled URL is filtered out.
			expect("databaseUrlUnpooled" in env.postgres).toBe(false);
		});

		test("returns selected keys across multiple namespaces", () => {
			vi.stubEnv("DATABASE_URL", "postgres://pooled");
			vi.stubEnv("DATABASE_URL_UNPOOLED", "postgres://direct");
			vi.stubEnv("NEON_AUTH_BASE_URL", "https://auth.example.com");
			vi.stubEnv("NEON_AUTH_JWKS_URL", "https://auth.example.com/jwks");
			const env = parseEnv(defineConfig({ auth: true }), [
				"DATABASE_URL",
				"NEON_AUTH_BASE_URL",
			]);
			expect(env.postgres.databaseUrl).toBe("postgres://pooled");
			expect(env.auth.baseUrl).toBe("https://auth.example.com");
			// Unselected keys are absent from their kept namespaces.
			expect("jwksUrl" in env.auth).toBe(false);
		});

		test("does not enforce vars the policy enables but the filter omits", () => {
			vi.stubEnv("DATABASE_URL", "postgres://pooled");
			// auth is enabled in the policy, but NEON_AUTH_* is unset — filtering to just
			// DATABASE_URL must not throw over the auth vars we never asked for.
			const env = parseEnv(defineConfig({ auth: true }), [
				"DATABASE_URL",
			]);
			expect(env.postgres.databaseUrl).toBe("postgres://pooled");
			expect("auth" in env).toBe(false);
		});

		test("throws EnvNotInjected listing only the missing selected keys", () => {
			vi.stubEnv("DATABASE_URL", "postgres://pooled");
			// DATABASE_URL_UNPOOLED is unset; selecting it must throw and name it.
			expect(() =>
				parseEnv(defineConfig({}), [
					"DATABASE_URL",
					"DATABASE_URL_UNPOOLED",
				]),
			).toThrowError(/DATABASE_URL_UNPOOLED is missing/);
		});

		test("rejects a selected-but-empty value", () => {
			vi.stubEnv("DATABASE_URL", "");
			expect(() => parseEnv(defineConfig({}), ["DATABASE_URL"])).toThrow(
				expect.objectContaining({ code: ErrorCode.EnvNotInjected }),
			);
		});

		test("an empty selection returns an empty object", () => {
			vi.stubEnv("DATABASE_URL", "postgres://pooled");
			expect(parseEnv(defineConfig({}), [])).toEqual({});
		});
	});

	test("projects env object to process env keys", () => {
		const pairs = toEntries({
			postgres: { databaseUrl: "a", databaseUrlUnpooled: "b" },
		});
		expect(pairs.DATABASE_URL).toBe("a");
		expect(pairs.DATABASE_URL_UNPOOLED).toBe("b");
	});

	test("projects the auth namespace (base + jwks URLs) to process env keys", () => {
		const config = defineConfig({ auth: true });
		const env: NeonEnv<typeof config> = {
			postgres: { databaseUrl: "a", databaseUrlUnpooled: "b" },
			auth: {
				baseUrl: "https://auth.example.com",
				jwksUrl: "https://auth.example.com/jwks.json",
			},
		};
		const pairs = toEntries(env);
		expect(pairs.NEON_AUTH_BASE_URL).toBe("https://auth.example.com");
		expect(pairs.NEON_AUTH_JWKS_URL).toBe(
			"https://auth.example.com/jwks.json",
		);
	});
});

describe("branch storage + AI Gateway (Preview)", () => {
	const callsTo = (api: FakeNeonApi, method: string) =>
		api.history.filter((h) => h.method === method).length;
	const lastCreateScopes = (api: FakeNeonApi): unknown => {
		const calls = api.history.filter(
			(h) => h.method === "createCredential",
		);
		const last = calls[calls.length - 1];
		return (last?.args[2] as { scopes?: unknown } | undefined)?.scopes;
	};

	test("no Preview feature: never touches credentials or storage endpoints", async () => {
		const { api, projectId } = seededFake();
		const env = await fetchEnv(defineConfig({ auth: false }), {
			api,
			projectId,
			branchId: "br-main",
		});
		expect("storage" in env).toBe(false);
		expect("aiGateway" in env).toBe(false);
		expect(callsTo(api, "createCredential")).toBe(0);
		expect(callsTo(api, "getProjectBranchStorage")).toBe(0);
	});

	test("buckets policy mints a credential + reads storage, surfacing the AWS storage env", async () => {
		const { api, projectId } = seededFake();
		const config = defineConfig({
			preview: { buckets: { uploads: { access: "public_read" } } },
		});
		const env = await fetchEnv(config, {
			api,
			projectId,
			branchId: "br-main",
		});
		expect(callsTo(api, "createCredential")).toBe(1);
		expect(callsTo(api, "getProjectBranchStorage")).toBe(1);
		expect(env.storage.secretAccessKey).toHaveLength(64);
		// The S3 access-key id must be the credential's FULL token id — the storage
		// gateway rejects the short token id with InvalidAccessKeyId. The fake mints
		// full ids as `<short>-fake-fake-fake-<seq>`, so the access key id must carry
		// that suffix and not equal the bare short id.
		expect(env.storage.accessKeyId).toContain("-fake-");
		expect(env.storage.endpoint).toContain("storage");
		expect(env.storage.region).toBe("us-east-1");
		expect("aiGateway" in env).toBe(false);
	});

	test("aiGateway policy surfaces the Neon AI Gateway env (token + bare base URL)", async () => {
		const { api, projectId } = seededFake();
		const env = await fetchEnv(
			defineConfig({ preview: { aiGateway: true } }),
			{
				api,
				projectId,
				branchId: "br-main",
				apiHost: "https://console-stage.neon.build/api/v2",
			},
		);
		expect(callsTo(api, "createCredential")).toBe(1);
		// AI Gateway needs no S3 connection info.
		expect(callsTo(api, "getProjectBranchStorage")).toBe(0);
		expect(env.aiGateway.apiKey).toMatch(/^nt_live_/);
		// Bare branch-scoped gateway host derived from the branch connection URI, NOT the API
		// origin — the provider appends the /ai-gateway/<dialect>/… routes itself.
		expect(env.aiGateway.baseUrl).toBe(
			"https://br-main-api.ai.aws-us-east-1.fake.neon.tech",
		);
		expect("storage" in env).toBe(false);
	});

	test("preserves the infra cell prefix (c-N.) from the connection host", async () => {
		// Production connection hosts carry a cell segment (`ep-x.c-3.<region>.…`). The gateway
		// is cell-routed, so that `c-3.` prefix must survive into the gateway host — dropping it
		// (the previous behavior) yields a host that resolves to the wrong cell or not at all.
		const api = new CellHostFakeNeonApi();
		const projectId = "proj-cell";
		api.seedProject({
			project: {
				id: projectId,
				name: "cell-test",
				regionId: "aws-us-east-2",
				pgVersion: 17,
			},
			branches: [
				{ branch: { id: "br-cell", name: "main", isDefault: true } },
			],
		});

		const env = await fetchEnv(
			defineConfig({ preview: { aiGateway: true } }),
			{ api, projectId, branchId: "br-cell" },
		);

		expect(env.aiGateway.baseUrl).toBe(
			"https://br-cell-api.ai.c-3.aws-us-east-2.fake.neon.tech",
		);
		// The emitted `NEON_AI_GATEWAY_BASE_URL` must carry the cell too.
		expect(toEntries(env).NEON_AI_GATEWAY_BASE_URL).toBe(
			"https://br-cell-api.ai.c-3.aws-us-east-2.fake.neon.tech",
		);
	});

	test("functions ride along on the credential's scopes but never mint alone", async () => {
		const { api, projectId } = seededFake();
		// functions-only: no credential, no storage read.
		const fnOnly = await fetchEnv(
			defineConfig({
				preview: {
					functions: { hello: { name: "h", source: "./h.ts" } },
				},
			}),
			{ api, projectId, branchId: "br-main" },
		);
		expect("storage" in fnOnly).toBe(false);
		expect("aiGateway" in fnOnly).toBe(false);
		expect(callsTo(api, "createCredential")).toBe(0);

		// buckets + functions: one credential carrying storage + functions:invoke.
		await fetchEnv(
			defineConfig({
				preview: {
					buckets: { uploads: {} },
					functions: { hello: { name: "h", source: "./h.ts" } },
				},
			}),
			{ api, projectId, branchId: "br-main" },
		);
		expect(lastCreateScopes(api)).toEqual([
			"storage:read",
			"storage:write",
			"functions:invoke",
		]);
	});

	test("round-trips a persisted credential instead of re-minting", async () => {
		const { api, projectId } = seededFake();
		const config = defineConfig({ preview: { buckets: { uploads: {} } } });
		const first = await fetchEnv(config, {
			api,
			projectId,
			branchId: "br-main",
		});
		const persisted = toEntries(first);
		const second = await fetchEnv(config, {
			api,
			projectId,
			branchId: "br-main",
			env: { ...process.env, ...persisted },
		});
		expect(callsTo(api, "createCredential")).toBe(1); // not minted again
		expect(second.storage.accessKeyId).toBe(first.storage.accessKeyId);
		expect(second.storage.secretAccessKey).toBe(
			first.storage.secretAccessKey,
		);
	});

	test("re-mints when a newly-enabled feature's secret is absent", async () => {
		const { api, projectId } = seededFake();
		// Persist a storage-only credential, then ask for a policy that also needs the AI Gateway
		// (NEON_AI_GATEWAY_TOKEN is absent from the persisted env, so the credential must be re-minted).
		const storageOnly = await fetchEnv(
			defineConfig({ preview: { buckets: { uploads: {} } } }),
			{ api, projectId, branchId: "br-main" },
		);
		const persisted = toEntries(storageOnly);
		const widened = await fetchEnv(
			defineConfig({
				preview: { buckets: { uploads: {} }, aiGateway: true },
			}),
			{
				api,
				projectId,
				branchId: "br-main",
				env: { ...process.env, ...persisted },
			},
		);
		expect(callsTo(api, "createCredential")).toBe(2); // re-minted
		expect(lastCreateScopes(api)).toContain("ai_gateway:invoke");
		expect(widened.aiGateway.apiKey).toMatch(/^nt_live_/);
	});

	test("credentials: verify replaces a .env.example placeholder with a real credential", async () => {
		// The bug this mode exists for. `packages/ai-sdk-provider/.env.example` used to ship a
		// token-shaped placeholder; copying it to `.env` and running a pull left it untouched,
		// because presence-based reuse can't tell a placeholder from a secret. Anything that
		// names no live credential on this branch must be replaced, not echoed back.
		const { api, projectId } = seededFake();
		const resolutions: CredentialResolution[] = [];

		const env = await fetchEnv(
			defineConfig({ preview: { aiGateway: true } }),
			{
				api,
				projectId,
				branchId: "br-main",
				env: { NEON_AI_GATEWAY_TOKEN: "nt_live_..." },
				credentials: "verify",
				onCredential: (resolution) => resolutions.push(resolution),
			},
		);

		expect(env.aiGateway.apiKey).not.toBe("nt_live_...");
		expect(env.aiGateway.apiKey).toMatch(/^nt_live_\w+_/);
		expect(callsTo(api, "createCredential")).toBe(1);
		// The placeholder named no credential, so there was nothing of ours to revoke.
		expect(callsTo(api, "revokeCredential")).toBe(0);
		expect(resolutions).toEqual([
			{
				action: "issued",
				keys: ["NEON_AI_GATEWAY_TOKEN"],
				revoked: [],
			},
		]);
	});

	test("credentials: verify reuses a credential that is still live and sufficiently scoped", async () => {
		// The everyday path: pull, then pull again. Verification must not turn into a rotation
		// on every run — that is the credential spam the presence check was avoiding.
		const { api, projectId } = seededFake();
		const config = defineConfig({ preview: { buckets: { uploads: {} } } });
		const first = await fetchEnv(config, {
			api,
			projectId,
			branchId: "br-main",
			credentials: "verify",
		});
		const resolutions: CredentialResolution[] = [];

		const second = await fetchEnv(config, {
			api,
			projectId,
			branchId: "br-main",
			env: { ...process.env, ...toEntries(first) },
			credentials: "verify",
			onCredential: (resolution) => resolutions.push(resolution),
		});

		expect(callsTo(api, "createCredential")).toBe(1); // not minted again
		expect(callsTo(api, "revokeCredential")).toBe(0);
		expect(second.storage.accessKeyId).toBe(first.storage.accessKeyId);
		expect(resolutions[0]?.action).toBe("reused");
		// `AWS_ACCESS_KEY_ID` is the credential's own token id, which is how the persisted
		// secrets name the credential that issued them without any local bookkeeping.
		expect(callsTo(api, "listCredentials")).toBe(1);
	});

	test("credentials: verify replaces a credential revoked out from under the .env", async () => {
		const { api, projectId } = seededFake();
		const config = defineConfig({ preview: { buckets: { uploads: {} } } });
		const first = await fetchEnv(config, {
			api,
			projectId,
			branchId: "br-main",
			credentials: "verify",
		});
		// e.g. revoked in the console, or expired. The secrets are still in `.env` and still
		// look perfectly real — only the branch knows they're dead.
		await api.revokeCredential(
			projectId,
			"br-main",
			first.storage.accessKeyId,
		);

		const second = await fetchEnv(config, {
			api,
			projectId,
			branchId: "br-main",
			env: { ...process.env, ...toEntries(first) },
			credentials: "verify",
		});

		expect(second.storage.accessKeyId).not.toBe(first.storage.accessKeyId);
		expect(callsTo(api, "createCredential")).toBe(2);
	});

	test("credentials: verify revokes the credential it replaces when the branch gains a feature", async () => {
		// Enabling the AI Gateway on a branch that already had storage widens the scopes the
		// credential needs, so the storage-only one has to be replaced. Its secrets lived only
		// in the env this call is superseding, so leaving it live would strand a usable
		// credential on the branch — one per pull, forever. This is the case that makes
		// "always mint" unaffordable and the reason reuse existed in the first place.
		const { api, projectId } = seededFake();
		const storageOnly = await fetchEnv(
			defineConfig({ preview: { buckets: { uploads: {} } } }),
			{ api, projectId, branchId: "br-main", credentials: "verify" },
		);
		const resolutions: CredentialResolution[] = [];

		const widened = await fetchEnv(
			defineConfig({
				preview: { buckets: { uploads: {} }, aiGateway: true },
			}),
			{
				api,
				projectId,
				branchId: "br-main",
				// The gateway token is simply absent — the branch didn't have the feature when
				// the last pull ran. The storage half still names the credential to supersede.
				env: { ...process.env, ...toEntries(storageOnly) },
				credentials: "verify",
				onCredential: (resolution) => resolutions.push(resolution),
			},
		);

		expect(callsTo(api, "createCredential")).toBe(2);
		expect(widened.storage.accessKeyId).not.toBe(
			storageOnly.storage.accessKeyId,
		);
		expect(resolutions[0]).toEqual({
			action: "issued",
			keys: [
				"AWS_ACCESS_KEY_ID",
				"AWS_SECRET_ACCESS_KEY",
				"NEON_AI_GATEWAY_TOKEN",
			],
			revoked: [storageOnly.storage.accessKeyId],
		});
		// One credential in, one credential out — the branch does not accumulate.
		const live = await api.listCredentials(projectId, "br-main");
		expect(live).toHaveLength(1);
		expect(live[0]?.tokenId).toBe(widened.storage.accessKeyId);
	});

	test("credentials: verify never revokes a credential this tool did not issue", async () => {
		// A credential minted by something else (a deployed function, a teammate, the console)
		// can be reused if it fits, but must never be revoked: its secrets live somewhere we
		// know nothing about.
		const { api, projectId } = seededFake();
		const foreign = await api.createCredential(projectId, "br-main", {
			scopes: ["storage:read"],
			principalType: "user",
			name: "minted-by-hand",
		});

		await fetchEnv(
			defineConfig({ preview: { buckets: { uploads: {} } } }),
			{
				api,
				projectId,
				branchId: "br-main",
				// Scoped `storage:read` only, so the policy's `storage:write` forces a replacement.
				env: {
					AWS_ACCESS_KEY_ID: foreign.tokenId,
					AWS_SECRET_ACCESS_KEY: foreign.s3SecretAccessKey,
				},
				credentials: "verify",
			},
		);

		expect(callsTo(api, "revokeCredential")).toBe(0);
		const live = await api.listCredentials(projectId, "br-main");
		expect(live.map((c) => c.tokenId)).toContain(foreign.tokenId);
	});

	test("credentials: verify re-mints when the storage and gateway halves name different credentials", async () => {
		// One credential backs both features, so halves stitched together from two different
		// pulls are not a credential — neither half can be trusted.
		const { api, projectId } = seededFake();
		const config = defineConfig({
			preview: { buckets: { uploads: {} }, aiGateway: true },
		});
		const a = await fetchEnv(config, {
			api,
			projectId,
			branchId: "br-main",
			credentials: "verify",
		});
		const b = await fetchEnv(config, {
			api,
			projectId,
			branchId: "br-main",
			credentials: "verify",
		});

		const mixed = await fetchEnv(config, {
			api,
			projectId,
			branchId: "br-main",
			env: {
				...toEntries(a),
				NEON_AI_GATEWAY_TOKEN: b.aiGateway.apiKey,
			},
			credentials: "verify",
		});

		expect(callsTo(api, "createCredential")).toBe(3);
		expect(mixed.storage.accessKeyId).not.toBe(a.storage.accessKeyId);
		expect(mixed.aiGateway.apiKey).not.toBe(b.aiGateway.apiKey);
	});

	test("credentials defaults to reuse: no credentials list, no rotation", async () => {
		// `neon dev` / `neon-env run` stay on the cheap presence check — they inject what a pull
		// already verified, and must not pay an API call (or risk a rotation) per start.
		const { api, projectId } = seededFake();
		const config = defineConfig({ preview: { buckets: { uploads: {} } } });
		const first = await fetchEnv(config, {
			api,
			projectId,
			branchId: "br-main",
		});
		const resolutions: CredentialResolution[] = [];

		await fetchEnv(config, {
			api,
			projectId,
			branchId: "br-main",
			env: { ...process.env, ...toEntries(first) },
			onCredential: (resolution) => resolutions.push(resolution),
		});

		expect(callsTo(api, "listCredentials")).toBe(0);
		expect(callsTo(api, "createCredential")).toBe(1);
		expect(resolutions[0]).toEqual({
			action: "reused",
			keys: ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"],
			revoked: [],
		});
	});

	test("throws when buckets are declared but storage is not enabled on the branch", async () => {
		const { api, projectId } = seededFake();
		api.seedStorageDisabled(projectId, "br-main");
		await expect(
			fetchEnv(defineConfig({ preview: { buckets: { uploads: {} } } }), {
				api,
				projectId,
				branchId: "br-main",
			}),
		).rejects.toMatchObject({ code: ErrorCode.NotFound });
		// The branch's storage settings are read before the credential is resolved, so a
		// resolve that cannot succeed never spends a credential on the way to failing.
		expect(callsTo(api, "createCredential")).toBe(0);
	});

	test("parseEnv reads injected storage env (sync, no network)", () => {
		vi.stubEnv("DATABASE_URL", "postgres://pooled");
		vi.stubEnv("DATABASE_URL_UNPOOLED", "postgres://direct");
		vi.stubEnv("AWS_ACCESS_KEY_ID", "abc123");
		vi.stubEnv("AWS_SECRET_ACCESS_KEY", "s".repeat(64));
		vi.stubEnv("AWS_ENDPOINT_URL_S3", "https://br.storage.neon.build");
		vi.stubEnv("AWS_REGION", "us-east-2");
		const env = parseEnv(
			defineConfig({ preview: { buckets: { uploads: {} } } }),
		);
		expect(env.storage.accessKeyId).toBe("abc123");
		expect(env.storage.endpoint).toBe("https://br.storage.neon.build");
		expect(env.storage.region).toBe("us-east-2");
	});

	test("parseEnv reads injected AI Gateway env", () => {
		vi.stubEnv("DATABASE_URL", "postgres://pooled");
		vi.stubEnv("DATABASE_URL_UNPOOLED", "postgres://direct");
		vi.stubEnv("NEON_AI_GATEWAY_TOKEN", "nt_live_abc_def");
		vi.stubEnv("NEON_AI_GATEWAY_BASE_URL", "https://x.neon.build");
		const env = parseEnv(defineConfig({ preview: { aiGateway: true } }));
		expect(env.aiGateway.apiKey).toBe("nt_live_abc_def");
		expect(env.aiGateway.baseUrl).toBe("https://x.neon.build");
	});

	test("parseEnv throws EnvNotInjected listing missing storage vars", () => {
		vi.stubEnv("DATABASE_URL", "postgres://pooled");
		vi.stubEnv("DATABASE_URL_UNPOOLED", "postgres://direct");
		expect(() =>
			parseEnv(defineConfig({ preview: { buckets: { uploads: {} } } })),
		).toThrowError(/AWS_ACCESS_KEY_ID is missing/);
	});

	test("parseEnv ignores storage/aiGateway for a non-Preview policy", () => {
		vi.stubEnv("DATABASE_URL", "postgres://pooled");
		vi.stubEnv("DATABASE_URL_UNPOOLED", "postgres://direct");
		const env = parseEnv(defineConfig({}));
		expect("storage" in env).toBe(false);
		expect("aiGateway" in env).toBe(false);
	});

	test("toEntries projects storage to AWS_* and aiGateway to NEON_AI_GATEWAY_*", () => {
		const config = defineConfig({
			preview: { buckets: { uploads: {} }, aiGateway: true },
		});
		const env: NeonEnv<typeof config> = {
			postgres: { databaseUrl: "a", databaseUrlUnpooled: "b" },
			storage: {
				accessKeyId: "akid",
				secretAccessKey: "secret",
				endpoint: "https://br.storage.neon.build",
				region: "us-east-2",
			},
			aiGateway: {
				apiKey: "nt_live_x_y",
				baseUrl: "https://x.neon.build",
			},
		};
		const pairs = toEntries(env);
		expect(pairs.AWS_ACCESS_KEY_ID).toBe("akid");
		expect(pairs.AWS_SECRET_ACCESS_KEY).toBe("secret");
		expect(pairs.AWS_ENDPOINT_URL_S3).toBe("https://br.storage.neon.build");
		expect(pairs.AWS_REGION).toBe("us-east-2");
		// Neon-branded vars only (no OpenAI projection): the token plus the bare branch
		// gateway host (no path) — the @neon/ai-sdk-provider appends the
		// /ai-gateway/<dialect>/… routes itself.
		expect(pairs.NEON_AI_GATEWAY_TOKEN).toBe("nt_live_x_y");
		expect(pairs.NEON_AI_GATEWAY_BASE_URL).toBe("https://x.neon.build");
		// The OpenAI SDK vars are no longer emitted.
		expect(pairs.OPENAI_API_KEY).toBeUndefined();
		expect(pairs.OPENAI_BASE_URL).toBeUndefined();
	});
});
