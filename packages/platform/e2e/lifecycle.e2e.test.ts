import { describe, expect } from "vitest";
import { defineConfig, pullConfig, pushConfig } from "../src/v1.js";
import {
	DEFAULT_REGION,
	detectApiKeyScope,
	e2eTest,
	makeRealApi,
	uniqueProjectName,
} from "./helpers.js";

describe("e2e — full lifecycle against real Neon API", () => {
	e2eTest(
		"first push creates project, second push is a no-op, third push is additive",
		async ({ track }) => {
			const scope = await detectApiKeyScope();
			if (scope.kind !== "org-or-user") {
				// project-scoped key — skip create flow.
				return;
			}

			const api = makeRealApi();
			const projectName = uniqueProjectName("lifecycle");
			const baseConfig = defineConfig({
				project: { name: projectName, region: DEFAULT_REGION },
				branchBlueprints: {
					production: {
						computeSettings: { autoscalingLimitMaxCu: 1 },
					},
				},
			});

			// 1. First push creates the project.
			const first = await pushConfig(baseConfig, { api });
			track(first.projectId);
			expect(first.conflicts).toHaveLength(0);
			expect(first.applied[0]).toMatchObject({
				kind: "project",
				action: "create",
			});

			const pulledAfterCreate = await pullConfig({
				api,
				projectId: first.projectId,
			});
			expect(pulledAfterCreate.project.name).toBe(projectName);

			// 2. Second push with identical config: no mutations.
			const second = await pushConfig(baseConfig, {
				api,
				projectId: first.projectId,
			});
			expect(second.conflicts).toHaveLength(0);
			expect(
				second.applied.filter((a) => a.action !== "noop"),
			).toHaveLength(0);

			// 3. Third push adds a `staging` branch. Should be additive — no conflicts, no flags.
			const withStaging = defineConfig({
				project: { name: projectName, region: DEFAULT_REGION },
				branchBlueprints: {
					production: {
						computeSettings: { autoscalingLimitMaxCu: 1 },
					},
					staging: { parent: "production" },
				},
			});
			const third = await pushConfig(withStaging, {
				api,
				projectId: first.projectId,
			});
			expect(third.conflicts).toHaveLength(0);
			expect(
				third.applied.some(
					(a) =>
						a.kind === "branch" &&
						a.action === "create" &&
						a.identifier === "staging",
				),
			).toBe(true);

			// 4. Pull again — staging is now in the round-tripped config.
			const pulledAfterAdd = await pullConfig({
				api,
				projectId: first.projectId,
			});
			expect(pulledAfterAdd.branchBlueprints?.staging).toBeDefined();
		},
	);

	e2eTest(
		"resolves an existing project by name when only orgId is supplied (no projectId)",
		async ({ track }) => {
			const scope = await detectApiKeyScope();
			if (scope.kind !== "org-or-user") return;

			const api = makeRealApi();
			const projectName = uniqueProjectName("byname");

			// Create via the SDK so we can rely on `pickProjectDefaultSettings`.
			const first = await pushConfig(
				defineConfig({
					project: { name: projectName, region: DEFAULT_REGION },
					branchBlueprints: { production: {} },
				}),
				{ api },
			);
			track(first.projectId);

			// Push the same config again WITHOUT projectId — the lookup-by-name path should find
			// the existing project rather than try to create a second one.
			const second = await pushConfig(
				defineConfig({
					project: { name: projectName, region: DEFAULT_REGION },
					branchBlueprints: { production: {} },
				}),
				{ api },
			);
			expect(second.projectId).toBe(first.projectId);
			expect(second.applied[0]).toMatchObject({
				kind: "project",
				action: "noop",
			});
		},
	);

	e2eTest(
		"project-scoped key path: getProject works against an already-existing project",
		async ({ track }) => {
			const scope = await detectApiKeyScope();
			const api = makeRealApi();

			let projectId: string;
			if (scope.kind === "org-or-user") {
				const created = await pushConfig(
					defineConfig({
						project: {
							name: uniqueProjectName("byid"),
							region: DEFAULT_REGION,
						},
						branchBlueprints: { production: {} },
					}),
					{ api },
				);
				track(created.projectId);
				projectId = created.projectId;
			} else {
				projectId = scope.projectId;
			}

			// The "project-scoped" path inside pushConfig — projectId supplied, listProjects is
			// never called. Works for both real project-scoped keys and for orgs that pass
			// projectId explicitly.
			const pulled = await pullConfig({ api, projectId });
			const result = await pushConfig(pulled, { api, projectId });
			expect(result.projectId).toBe(projectId);
			expect(result.conflicts).toHaveLength(0);
		},
	);
});
