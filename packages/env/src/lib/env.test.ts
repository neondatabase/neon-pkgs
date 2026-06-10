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
		const config = defineConfig({ auth: true });

		const env = parseEnv(config);

		expectType<NeonEnv<typeof config>>(env);
		expectType<NeonAuthEnv>(env.auth);
		// @ts-expect-error auth: true must not imply Data API env.
		env.dataApi;
		expect(env.auth.baseUrl).toBe("https://auth.example.com");
	});

	test("rejects an empty NEON_AUTH_BASE_URL value", () => {
		vi.stubEnv("DATABASE_URL", "postgres://pooled");
		vi.stubEnv("DATABASE_URL_UNPOOLED", "postgres://direct");
		vi.stubEnv("NEON_AUTH_BASE_URL", "");

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
		const env = parseEnv(defineConfig({ auth: {} }));
		expect(env.auth.baseUrl).toBe("https://auth.example.com");
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
});
