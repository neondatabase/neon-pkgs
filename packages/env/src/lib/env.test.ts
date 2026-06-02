import {
	type BranchConfig,
	defineConfig,
	ErrorCode,
} from "@neondatabase/config/v1";
import { beforeEach, describe, expect, test, vi } from "vitest";
import {
	fetchEnv,
	type NeonAuthEnv,
	type NeonEnv,
	neonEnvToProcessEnv,
	parseEnv,
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

describe("fetchEnv", () => {
	test("fetches postgres env for selected branch", async () => {
		const { api, projectId } = seededFake();
		const config = defineConfig(() => ({}));
		const env = await fetchEnv(config, {
			api,
			projectId,
			branchId: "br-main",
		});
		expect(env.postgres.databaseUrl).toContain("postgresql://");
		expect(env.postgres.databaseUrl).toContain("-pooler");
	});

	test("requires auth integration when branch policy enables auth", async () => {
		const { api, projectId } = seededFake();
		const config = defineConfig(() => ({ auth: {} }));
		await expect(
			fetchEnv(config, { api, projectId, branchId: "br-main" }),
		).rejects.toMatchObject({ code: ErrorCode.NotFound });
	});

	test("returns the integration base URL from the live snapshot", async () => {
		const { api, projectId } = seededFake();
		await api.enableNeonAuth(projectId, "br-main");
		const config = defineConfig(() => ({ auth: {} }));

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
		const config = defineConfig(() => ({ auth: {} }));

		const env = await fetchEnv(config, {
			api,
			projectId,
			branchId: "br-main",
			env: { NEON_AUTH_BASE_URL: "https://auth.example.com" },
		});

		expect(env.auth.baseUrl).toBe("https://auth.example.com");
	});
});

describe("parseEnv", () => {
	test("parses postgres env synchronously", () => {
		vi.stubEnv("DATABASE_URL", "postgres://pooled");
		vi.stubEnv("DATABASE_URL_UNPOOLED", "postgres://direct");
		const env = parseEnv(
			defineConfig(() => ({})),
			"main",
		);
		expect(env.postgres.databaseUrl).toBe("postgres://pooled");
	});

	test("requires service env when service namespaces are present", () => {
		vi.stubEnv("DATABASE_URL", "postgres://pooled");
		vi.stubEnv("DATABASE_URL_UNPOOLED", "postgres://direct");
		const config = defineConfig(() => ({
			auth: {},
			dataApi: {},
		}));

		expect(() => parseEnv(config, "main")).toThrow(
			expect.objectContaining({ code: ErrorCode.EnvNotInjected }),
		);
	});

	test("types auth env when config spreads BranchConfig defaults", () => {
		vi.stubEnv("DATABASE_URL", "postgres://pooled");
		vi.stubEnv("DATABASE_URL_UNPOOLED", "postgres://direct");
		vi.stubEnv("NEON_AUTH_BASE_URL", "https://auth.example.com");
		const config = defineConfig((branch) => {
			const defaults: BranchConfig = {
				auth: {},
			};

			if (branch.name === "main") {
				return {
					...defaults,
					protected: true,
				};
			}

			return {
				...defaults,
				parent: "main",
				ttl: "7d",
			};
		});

		const env = parseEnv(config, "main");

		expectType<NeonEnv<typeof config>>(env);
		expectType<NeonAuthEnv>(env.auth);
		// @ts-expect-error Auth defaults must not imply Data API env.
		env.dataApi;
		expect(env.auth.baseUrl).toBe("https://auth.example.com");
	});

	test("rejects an empty NEON_AUTH_BASE_URL value", () => {
		vi.stubEnv("DATABASE_URL", "postgres://pooled");
		vi.stubEnv("DATABASE_URL_UNPOOLED", "postgres://direct");
		vi.stubEnv("NEON_AUTH_BASE_URL", "");

		expect(() =>
			parseEnv(
				defineConfig(() => ({ auth: {} })),
				"main",
			),
		).toThrow(expect.objectContaining({ code: ErrorCode.EnvNotInjected }));
	});

	test("projects env object to process env keys", () => {
		const pairs = neonEnvToProcessEnv({
			postgres: { databaseUrl: "a", databaseUrlUnpooled: "b" },
		});
		expect(pairs.DATABASE_URL).toBe("a");
		expect(pairs.DATABASE_URL_UNPOOLED).toBe("b");
	});
});
