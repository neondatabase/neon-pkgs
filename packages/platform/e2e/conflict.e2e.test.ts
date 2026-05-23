import { describe, expect } from "vitest";
import { defineConfig, errors, pushConfig } from "../src/v1.js";
import {
	DEFAULT_REGION,
	detectApiKeyScope,
	e2eTest,
	makeRealApi,
	uniqueProjectName,
} from "./helpers.js";

describe("e2e — conflict detection against real Neon API", () => {
	e2eTest(
		"region drift is reported even with applyChanges:true (region is immutable on Neon)",
		async ({ track }) => {
			const scope = await detectApiKeyScope();
			if (scope.kind !== "org-or-user") return;

			const api = makeRealApi();
			const projectName = uniqueProjectName("region");

			const created = await pushConfig(
				defineConfig({
					project: { name: projectName, region: DEFAULT_REGION },
					branches: { production: {} },
				}),
				{ api },
			);
			track(created.projectId);

			// Same project, different region. By default → throws PushConflictError. With
			// applyChanges:true → reports the conflict in the result without throwing.
			const wrongRegion = defineConfig({
				project: { name: projectName, region: "aws-eu-central-1" },
				branches: { production: {} },
			});

			await expect(
				pushConfig(wrongRegion, { api, projectId: created.projectId }),
			).rejects.toBeInstanceOf(errors.PushConflictError);

			const forced = await pushConfig(wrongRegion, {
				api,
				projectId: created.projectId,
				applyChanges: true,
			});
			expect(forced.conflicts).toContainEqual(
				expect.objectContaining({ kind: "project", field: "region" }),
			);
		},
	);

	e2eTest(
		"compute drift on production: default refuses, updateExisting applies",
		async ({ track }) => {
			const scope = await detectApiKeyScope();
			if (scope.kind !== "org-or-user") return;

			const api = makeRealApi();
			const projectName = uniqueProjectName("compute");

			// Create with default compute (0.25 / 0.25).
			const created = await pushConfig(
				defineConfig({
					project: { name: projectName, region: DEFAULT_REGION },
					branches: { production: {} },
				}),
				{ api },
			);
			track(created.projectId);

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
				pushConfig(bigger, { api, projectId: created.projectId }),
			).rejects.toBeInstanceOf(errors.PushConflictError);

			// With updateExisting:true the drift is applied as an endpoint update.
			const applied = await pushConfig(bigger, {
				api,
				projectId: created.projectId,
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
			const endpoints = await api.listEndpoints(created.projectId);
			const branches = await api.listBranches(created.projectId);
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
