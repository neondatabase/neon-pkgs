import { beforeEach, describe, expect, test, vi } from "vitest";
import { defineConfig } from "./define-config.js";
import {
	fetchEnv,
	type NeonAuthEnv,
	type NeonEnv,
	neonEnvToProcessEnv,
	parseEnv,
} from "./env.js";
import { ErrorCode } from "./errors.js";
import { FakeNeonApi } from "./fake-neon-api.js";
import { stubCleanNeonEnv } from "./test-utils.js";
import type { BranchConfig } from "./types.js";

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
		const env = await fetchEnv(config, { api, projectId, branch: "main" });
		expect(env.postgres.databaseUrl).toContain("postgresql://");
		expect(env.postgres.databaseUrl).toContain("-pooler");
	});

	test("requires auth integration when branch policy enables auth", async () => {
		const { api, projectId } = seededFake();
		const config = defineConfig(() => ({ auth: {} }));
		await expect(
			fetchEnv(config, { api, projectId, branch: "main" }),
		).rejects.toMatchObject({ code: ErrorCode.NotFound });
	});
});

describe("parseEnv", () => {
	test("parses postgres env synchronously", () => {
		vi.stubEnv("DATABASE_URL", "postgres://pooled");
		vi.stubEnv("DATABASE_URL_UNPOOLED", "postgres://direct");
		const env = parseEnv(defineConfig(() => ({})));
		expect(env.postgres.databaseUrl).toBe("postgres://pooled");
	});

	test("requires feature env when feature namespaces are present", () => {
		vi.stubEnv("DATABASE_URL", "postgres://pooled");
		vi.stubEnv("DATABASE_URL_UNPOOLED", "postgres://direct");
		const config = defineConfig(() => ({
			auth: {},
			dataApi: {},
		}));

		expect(() => parseEnv(config)).toThrow(
			expect.objectContaining({ code: ErrorCode.EnvNotInjected }),
		);
	});

	test("types auth env when config spreads BranchConfig defaults", () => {
		vi.stubEnv("DATABASE_URL", "postgres://pooled");
		vi.stubEnv("DATABASE_URL_UNPOOLED", "postgres://direct");
		vi.stubEnv("NEON_AUTH_PROJECT_ID", "auth-project");
		vi.stubEnv("NEON_AUTH_PUBLISHABLE_CLIENT_KEY", "pub");
		vi.stubEnv("NEON_AUTH_SECRET_SERVER_KEY", "secret");
		vi.stubEnv("NEON_AUTH_JWKS_URL", "https://example.com/jwks.json");
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

		const env = parseEnv(config);

		expectType<NeonEnv<typeof config>>(env);
		expectType<NeonAuthEnv>(env.auth);
		// @ts-expect-error Auth defaults must not imply Data API env.
		env.dataApi;
		expect(env.auth.projectId).toBe("auth-project");
	});

	test("projects env object to process env keys", () => {
		const pairs = neonEnvToProcessEnv({
			postgres: { databaseUrl: "a", databaseUrlUnpooled: "b" },
		});
		expect(pairs.DATABASE_URL).toBe("a");
		expect(pairs.DATABASE_URL_UNPOOLED).toBe("b");
	});
});
