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

describe("e2e — branch policy lifecycle", () => {
	e2eTest(
		"protects main and applies 0.25-3 CU on a new dev branch",
		async ({ track }) => {
			const scope = await detectApiKeyScope();
			if (scope.kind !== "org-or-user") return;
			const api = makeRealApi();
			const projectId = await bootstrapProject(api, {
				name: uniqueProjectName("life"),
				region: DEFAULT_REGION,
			});
			track(projectId);
			const main = (await api.listBranches(projectId)).find(
				(b) => b.isDefault,
			);
			if (!main) throw new Error("missing default branch");
			const config = defineConfig({
				branch: (b) =>
					b.name === main.name
						? { protected: true }
						: {
								parent: main.name,
								ttl: "1h",
								postgres: {
									computeSettings: {
										autoscalingLimitMinCu: 0.25,
										autoscalingLimitMaxCu: 3,
									},
								},
							},
			});
			const created = await api.createBranch(projectId, {
				name: "dev",
				parentId: main.id,
			});
			expect(created.branch.name).toBe("dev");
			await pushConfig(config, {
				api,
				projectId,
				branchId: main.id,
				updateExisting: true,
			});
			await pushConfig(config, {
				api,
				projectId,
				branchId: created.branch.id,
				updateExisting: true,
			});
			const reread = (await api.listBranches(projectId)).find(
				(b) => b.id === main.id,
			);
			expect(reread?.protected).toBe(true);
			const endpoint = (await api.listEndpoints(projectId)).find(
				(e) =>
					e.branchId === created.branch.id && e.type === "read_write",
			);
			expect(endpoint?.autoscalingLimitMinCu).toBe(0.25);
			expect(endpoint?.autoscalingLimitMaxCu).toBe(3);
		},
	);
});
