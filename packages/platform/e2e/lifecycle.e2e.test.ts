import { describe, expect } from "vitest";
import { branch, checkout, defineConfig, pushConfig } from "../src/v1.js";
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
		"creates a dev branch, checks out main, and pushes main policy",
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
			const config = defineConfig((b) =>
				b.name === main.name
					? { protected: true }
					: { parent: main.name, ttl: "1h" },
			);
			const created = await branch({
				name: "dev",
				projectId,
				api,
				gitBranch: null,
			});
			expect(created.branchName).toMatch(/^dev-/);
			const checked = await checkout({
				branch: main.name,
				projectId,
				api,
			});
			expect(checked.branchId).toBe(main.id);
			await pushConfig(config, {
				api,
				projectId,
				branch: main.id,
				updateExisting: true,
			});
			const reread = (await api.listBranches(projectId)).find(
				(b) => b.id === main.id,
			);
			expect(reread?.protected).toBe(true);
		},
	);
});
