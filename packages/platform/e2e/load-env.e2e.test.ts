import { describe, expect } from "vitest";
import { defineConfig, loadEnv, pushConfig } from "../src/v1.js";
import {
	DEFAULT_REGION,
	detectApiKeyScope,
	e2eTest,
	makeRealApi,
	uniqueProjectName,
} from "./helpers.js";

describe("e2e — loadEnv against real Neon API", () => {
	e2eTest(
		"returns DATABASE_URL + DATABASE_URL_UNPOOLED that point at the default branch",
		async ({ track }) => {
			const scope = await detectApiKeyScope();
			if (scope.kind !== "org-or-user") return;

			const api = makeRealApi();
			const projectName = uniqueProjectName("loadenv");
			const config = defineConfig({
				project: { name: projectName, region: DEFAULT_REGION },
				branches: { production: {} },
			});

			const pushed = await pushConfig(config, { api });
			track(pushed.projectId);

			const env = await loadEnv(config, {
				api,
				projectId: pushed.projectId,
				env: {},
			});

			expect(Object.keys(env).sort()).toEqual([
				"DATABASE_URL",
				"DATABASE_URL_UNPOOLED",
			]);

			// Both URIs must be valid Postgres URIs targeting the same database + role.
			const pooled = new URL(env.DATABASE_URL);
			const direct = new URL(env.DATABASE_URL_UNPOOLED);
			expect(pooled.protocol).toMatch(/^postgres(ql)?:$/);
			expect(direct.protocol).toMatch(/^postgres(ql)?:$/);
			expect(pooled.username).toBe(direct.username);
			expect(pooled.pathname).toBe(direct.pathname);

			// Pooled host always carries the `-pooler` segment in Neon.
			expect(pooled.host).toContain("-pooler");
			expect(direct.host).not.toContain("-pooler");
		},
	);

	e2eTest(
		"explicit databaseUrlKey overrides the default keys",
		async ({ track }) => {
			const scope = await detectApiKeyScope();
			if (scope.kind !== "org-or-user") return;

			const api = makeRealApi();
			const projectName = uniqueProjectName("loadenv-keys");
			const config = defineConfig({
				project: { name: projectName, region: DEFAULT_REGION },
				branches: { production: {} },
				env: {
					databaseUrl: "POSTGRES_URL",
					databaseUrlUnpooled: "POSTGRES_URL_NON_POOLING",
				},
			});

			const pushed = await pushConfig(config, { api });
			track(pushed.projectId);

			const env = await loadEnv(config, {
				api,
				projectId: pushed.projectId,
				env: {},
			});

			expect(Object.keys(env).sort()).toEqual([
				"POSTGRES_URL",
				"POSTGRES_URL_NON_POOLING",
			]);
			expect(env.POSTGRES_URL).toContain("-pooler");
			expect(env.POSTGRES_URL_NON_POOLING).not.toContain("-pooler");
		},
	);
});
