import { describe, expect } from "vitest";
import { defineConfig, errors, pushConfig } from "../src/v1.js";
import {
	bootstrapProject,
	DEFAULT_REGION,
	detectApiKeyScope,
	e2eTest,
	makeRealApi,
	uniqueProjectName,
} from "./helpers.js";

describe("e2e — conflict detection against real Neon API", () => {
	e2eTest(
		"region drift always throws — region is immutable on Neon and no flag overrides it",
		async ({ track }) => {
			const scope = await detectApiKeyScope();
			if (scope.kind !== "org-or-user") return;

			const api = makeRealApi();
			const projectId = await bootstrapProject(api, {
				name: uniqueProjectName("region"),
				region: DEFAULT_REGION,
			});
			track(projectId);

			const wrongRegion = defineConfig({
				project: { name: "renamed", region: "aws-eu-central-1" },
				branches: { production: {} },
			});

			// Default: throws PushConflictError on the region mismatch.
			await expect(
				pushConfig(wrongRegion, { api, projectId }),
			).rejects.toBeInstanceOf(errors.PushConflictError);

			// updateExisting:true does not save us — region is immutable, so it still throws.
			await expect(
				pushConfig(wrongRegion, {
					api,
					projectId,
					updateExisting: true,
				}),
			).rejects.toBeInstanceOf(errors.PushConflictError);
		},
	);

	e2eTest(
		"compute drift on production: default refuses, updateExisting applies",
		async ({ track }) => {
			const scope = await detectApiKeyScope();
			if (scope.kind !== "org-or-user") return;

			const api = makeRealApi();
			const projectName = uniqueProjectName("compute");
			const projectId = await bootstrapProject(api, {
				name: projectName,
				region: DEFAULT_REGION,
			});
			track(projectId);

			// Now push a config that wants max=2 on production. Should be a conflict by default.
			const bigger = defineConfig({
				project: { name: projectName, region: DEFAULT_REGION },
				branches: {
					production: {
						computeSettings: { autoscalingLimitMaxCu: 2 },
					},
				},
			});
			await expect(
				pushConfig(bigger, { api, projectId }),
			).rejects.toBeInstanceOf(errors.PushConflictError);

			// With updateExisting:true the drift is applied as an endpoint update.
			const applied = await pushConfig(bigger, {
				api,
				projectId,
				updateExisting: true,
			});
			expect(applied.conflicts).toHaveLength(0);
			expect(applied.applied).toContainEqual(
				expect.objectContaining({
					kind: "branch",
					action: "update",
					identifier: "production",
				}),
			);

			// Confirm via a fresh listEndpoints — the change actually landed on Neon.
			const endpoints = await api.listEndpoints(projectId);
			const branches = await api.listBranches(projectId);
			const prodBranchId = branches.find(
				(b) => b.name === "production",
			)?.id;
			const prodEndpoint = endpoints.find(
				(e) => e.branchId === prodBranchId && e.type === "read_write",
			);
			expect(prodEndpoint?.autoscalingLimitMaxCu).toBe(2);
		},
	);
});
