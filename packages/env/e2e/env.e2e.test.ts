import { defineConfig } from "@neondatabase/config/v1";
import { describe, expect } from "vitest";
import { fetchEnv } from "../src/index.js";
import {
	bootstrapProject,
	DEFAULT_REGION,
	detectApiKeyScope,
	e2eTest,
	makeRealApi,
	uniqueProjectName,
} from "./helpers.js";

describe("e2e — fetchEnv against real Neon API", () => {
	e2eTest("returns Postgres env for selected branch", async ({ track }) => {
		const scope = await detectApiKeyScope();
		const api = makeRealApi();
		const projectId =
			scope.kind === "org-or-user"
				? await bootstrapProject(api, {
						name: uniqueProjectName("env"),
						region: DEFAULT_REGION,
					})
				: scope.projectId;
		if (scope.kind === "org-or-user") track(projectId);
		const branchId = (await api.listBranches(projectId)).find(
			(b) => b.isDefault,
		)?.id;
		if (!branchId) throw new Error("missing default branch");
		const env = await fetchEnv(defineConfig({}), {
			api,
			projectId,
			branchId,
		});
		expect(env.postgres.databaseUrl).toContain("postgresql://");
		expect(env.postgres.databaseUrlUnpooled).toContain("postgresql://");
	});
});
