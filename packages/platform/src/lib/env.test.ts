import { beforeEach, describe, expect, test, vi } from "vitest";
import { defineConfig } from "./define-config.js";
import { fetchEnv, neonEnvToProcessEnv, parseEnv } from "./env.js";
import { ErrorCode } from "./errors.js";
import { FakeNeonApi } from "./fake-neon-api.js";
import { stubCleanNeonEnv } from "./test-utils.js";

beforeEach(() => stubCleanNeonEnv());

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
		const config = defineConfig(() => ({ auth: { enabled: true } }));
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

	test("projects env object to process env keys", () => {
		const pairs = neonEnvToProcessEnv({
			postgres: { databaseUrl: "a", databaseUrlUnpooled: "b" },
		});
		expect(pairs.DATABASE_URL).toBe("a");
		expect(pairs.DATABASE_URL_UNPOOLED).toBe("b");
	});
});
