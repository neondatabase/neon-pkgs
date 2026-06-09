import { describe, expect } from "vitest";
import { defineConfig, pushConfig } from "../src/v1.js";
import {
	bootstrapProject,
	DEFAULT_REGION,
	detectApiKeyScope,
	e2eTest,
	makeRealApi,
	uniqueProjectName,
} from "./helpers.js";

describe("e2e — branch-scoped push conflicts", () => {
	e2eTest(
		"reports branch drift without updateExisting",
		async ({ track }) => {
			const scope = await detectApiKeyScope();
			if (scope.kind !== "org-or-user") return;
			const api = makeRealApi();
			const projectId = await bootstrapProject(api, {
				name: uniqueProjectName("conflict"),
				region: DEFAULT_REGION,
			});
			track(projectId);
			const branchId = (await api.listBranches(projectId)).find(
				(b) => b.isDefault,
			)?.id;
			if (!branchId) throw new Error("missing default branch");
			const config = defineConfig({
				branch: () => ({ protected: true }),
			});
			await expect(
				pushConfig(config, { api, projectId, branchId }),
			).rejects.toMatchObject({ code: "PLATFORM_PUSH_CONFLICT" });
		},
	);
});
