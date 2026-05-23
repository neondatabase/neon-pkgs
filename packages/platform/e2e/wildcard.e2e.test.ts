import { describe, expect } from "vitest";
import { defineConfig, pushConfig } from "../src/v1.js";
import {
	DEFAULT_REGION,
	detectApiKeyScope,
	e2eTest,
	makeRealApi,
	uniqueProjectName,
} from "./helpers.js";

describe("e2e — wildcard blueprints against real Neon API", () => {
	e2eTest(
		"default: matching existing branches are reported as skipped without mutation",
		async ({ track }) => {
			const scope = await detectApiKeyScope();
			if (scope.kind !== "org-or-user") return;

			const api = makeRealApi();
			const projectName = uniqueProjectName("wild-skip");

			// Step 1: create the project.
			const created = await pushConfig(
				defineConfig({
					project: { name: projectName, region: DEFAULT_REGION },
					branches: { production: {} },
				}),
				{ api },
			);
			track(created.projectId);

			// Step 2: create a branch matching the wildcard via the raw NeonApi (simulates a
			// developer creating `preview-pr-42` directly with `neon branches create` or via
			// the console — the blueprint then governs it without re-creating).
			const branches = await api.listBranches(created.projectId);
			const prod = branches.find((b) => b.name === "production");
			if (!prod)
				throw new Error("Expected an auto-created production branch");
			await api.createBranch(created.projectId, {
				name: "preview-pr-42",
				parentId: prod.id,
			});

			// Step 3: push a config with a wildcard blueprint that wants different settings.
			// Without --apply-existing this is a no-op for the preview branch.
			const beforeEndpoints = await api.listEndpoints(created.projectId);
			const result = await pushConfig(
				defineConfig({
					project: { name: projectName, region: DEFAULT_REGION },
					branches: { production: {} },
					branchBlueprints: {
						preview: {
							pattern: "preview-*",
							computeSettings: { autoscalingLimitMaxCu: 2 },
						},
					},
				}),
				{ api, projectId: created.projectId },
			);
			expect(result.skippedWildcardBranches).toEqual([
				expect.objectContaining({
					pattern: "preview-*",
					branches: ["preview-pr-42"],
				}),
			]);

			const afterEndpoints = await api.listEndpoints(created.projectId);
			expect(
				afterEndpoints.map((e) => e.autoscalingLimitMaxCu).sort(),
			).toEqual(
				beforeEndpoints.map((e) => e.autoscalingLimitMaxCu).sort(),
			);
		},
	);

	e2eTest(
		"--apply-existing applies wildcard blueprint settings to every matching branch",
		async ({ track }) => {
			const scope = await detectApiKeyScope();
			if (scope.kind !== "org-or-user") return;

			const api = makeRealApi();
			const projectName = uniqueProjectName("wild-apply");

			const created = await pushConfig(
				defineConfig({
					project: { name: projectName, region: DEFAULT_REGION },
					branches: { production: {} },
				}),
				{ api },
			);
			track(created.projectId);

			const branches = await api.listBranches(created.projectId);
			const prod = branches.find((b) => b.name === "production");
			if (!prod)
				throw new Error("Expected an auto-created production branch");
			const previewA = await api.createBranch(created.projectId, {
				name: "preview-a",
				parentId: prod.id,
			});
			const previewB = await api.createBranch(created.projectId, {
				name: "preview-b",
				parentId: prod.id,
			});

			const result = await pushConfig(
				defineConfig({
					project: { name: projectName, region: DEFAULT_REGION },
					branches: { production: {} },
					branchBlueprints: {
						preview: {
							pattern: "preview-*",
							computeSettings: { autoscalingLimitMaxCu: 2 },
						},
					},
				}),
				{ api, projectId: created.projectId, applyExisting: true },
			);
			expect(result.skippedWildcardBranches).toHaveLength(0);
			expect(
				result.applied.filter((a) =>
					a.identifier?.startsWith("preview-"),
				).length,
			).toBeGreaterThanOrEqual(2);

			const endpoints = await api.listEndpoints(created.projectId);
			for (const branch of [previewA.branch, previewB.branch]) {
				const ep = endpoints.find(
					(e) => e.branchId === branch.id && e.type === "read_write",
				);
				expect(ep?.autoscalingLimitMaxCu).toBe(2);
			}
		},
	);
});
