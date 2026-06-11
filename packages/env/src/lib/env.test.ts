import { defineConfig, ErrorCode } from "@neondatabase/config/v1";
import { beforeEach, describe, expect, test, vi } from "vitest";
import {
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
});

describe("parseEnv", () => {
	test("parses postgres env synchronously (external scope)", () => {
		vi.stubEnv("DATABASE_URL", "postgres://pooled");
		vi.stubEnv("DATABASE_URL_UNPOOLED", "postgres://direct");
		const env = parseEnv(defineConfig({}));
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
		const env = parseEnv(defineConfig({ dataApi: { enabled: true } }));
		expect(env.dataApi.url).toBe("https://data.example.com");
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
		// The S3 access-key id is the credential's short token id (embedded in api_token).
		expect(env.storage.accessKeyId).not.toBe("");
		expect(env.storage.endpoint).toContain("storage");
		expect(env.storage.region).toBe("us-east-1");
		expect(env.storage.forcePathStyle).toBe(true);
		expect("aiGateway" in env).toBe(false);
	});

	test("aiGateway policy surfaces the OpenAI env (key + OpenAI-dialect base URL)", async () => {
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
		// Branch-scoped gateway host derived from the branch connection URI, NOT the API origin.
		expect(env.aiGateway.baseUrl).toBe(
			"https://br-main-api.ai.aws-us-east-1.fake.neon.tech/ai-gateway/openai/v1",
		);
		expect("storage" in env).toBe(false);
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
		// (OPENAI_API_KEY is absent from the persisted env, so the credential must be re-minted).
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
	});

	test("parseEnv reads injected storage env (sync, no network)", () => {
		vi.stubEnv("DATABASE_URL", "postgres://pooled");
		vi.stubEnv("DATABASE_URL_UNPOOLED", "postgres://direct");
		vi.stubEnv("AWS_ACCESS_KEY_ID", "abc123");
		vi.stubEnv("AWS_SECRET_ACCESS_KEY", "s".repeat(64));
		vi.stubEnv("AWS_ENDPOINT_URL_S3", "https://br.storage.neon.build");
		vi.stubEnv("AWS_REGION", "us-east-2");
		vi.stubEnv("NEON_STORAGE_FORCE_PATH_STYLE", "true");
		const env = parseEnv(
			defineConfig({ preview: { buckets: { uploads: {} } } }),
		);
		expect(env.storage.accessKeyId).toBe("abc123");
		expect(env.storage.endpoint).toBe("https://br.storage.neon.build");
		expect(env.storage.region).toBe("us-east-2");
		expect(env.storage.forcePathStyle).toBe(true);
	});

	test("parseEnv reads injected AI Gateway env", () => {
		vi.stubEnv("DATABASE_URL", "postgres://pooled");
		vi.stubEnv("DATABASE_URL_UNPOOLED", "postgres://direct");
		vi.stubEnv("OPENAI_API_KEY", "nt_live_abc_def");
		vi.stubEnv(
			"OPENAI_BASE_URL",
			"https://x.neon.build/ai-gateway/openai/v1",
		);
		const env = parseEnv(defineConfig({ preview: { aiGateway: true } }));
		expect(env.aiGateway.apiKey).toBe("nt_live_abc_def");
		expect(env.aiGateway.baseUrl).toBe(
			"https://x.neon.build/ai-gateway/openai/v1",
		);
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

	test("toEntries projects storage to AWS_* (+ NEON_STORAGE_*) and aiGateway to OPENAI_* (+ NEON_AI_GATEWAY_*)", () => {
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
				forcePathStyle: true,
			},
			aiGateway: {
				apiKey: "nt_live_x_y",
				baseUrl: "https://x.neon.build/ai-gateway/openai/v1",
			},
		};
		const pairs = toEntries(env);
		expect(pairs.AWS_ACCESS_KEY_ID).toBe("akid");
		expect(pairs.AWS_SECRET_ACCESS_KEY).toBe("secret");
		expect(pairs.AWS_ENDPOINT_URL_S3).toBe("https://br.storage.neon.build");
		expect(pairs.AWS_REGION).toBe("us-east-2");
		expect(pairs.NEON_STORAGE_REGION).toBe("us-east-2");
		expect(pairs.NEON_STORAGE_FORCE_PATH_STYLE).toBe("true");
		expect(pairs.OPENAI_API_KEY).toBe("nt_live_x_y");
		expect(pairs.OPENAI_BASE_URL).toBe(
			"https://x.neon.build/ai-gateway/openai/v1",
		);
		// Neon-branded aliases: same token, provider-neutral base (no OpenAI-dialect suffix).
		expect(pairs.NEON_AI_GATEWAY_TOKEN).toBe("nt_live_x_y");
		expect(pairs.NEON_AI_GATEWAY_BASE_URL).toBe(
			"https://x.neon.build/ai-gateway",
		);
	});
});
