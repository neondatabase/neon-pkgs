import { describe, expect } from "vitest";
import { defineConfig, errors, pullConfig, pushConfig } from "../src/v1.js";
import {
	bootstrapProject,
	DEFAULT_REGION,
	detectApiKeyScope,
	e2eTest,
	makeRealApi,
	uniqueProjectName,
} from "./helpers.js";

describe("e2e — full lifecycle against real Neon API", () => {
	e2eTest(
		"push against a pre-existing project: first push is additive, second is a no-op",
		async ({ track }) => {
			const scope = await detectApiKeyScope();
			if (scope.kind !== "org-or-user") {
				// project-scoped key — skip create flow.
				return;
			}

			const api = makeRealApi();
			const projectName = uniqueProjectName("lifecycle");
			// Bootstrap the project out-of-band — pushConfig itself never creates projects.
			const projectId = await bootstrapProject(api, {
				name: projectName,
				region: DEFAULT_REGION,
			});
			track(projectId);

			const baseConfig = defineConfig({
				project: { name: projectName, region: DEFAULT_REGION },
				branches: {
					production: {},
					staging: { parent: "production" },
				},
			});

			// 1. First push: additive — creates the staging branch alongside the
			// auto-created production branch.
			const first = await pushConfig(baseConfig, { api, projectId });
			expect(first.conflicts).toHaveLength(0);
			expect(
				first.applied.some(
					(a) =>
						a.kind === "branch" &&
						a.action === "create" &&
						a.identifier === "staging",
				),
			).toBe(true);

			// 2. Pull round-trips production + staging.
			const pulled = await pullConfig({ api, projectId });
			expect(pulled.branches?.production).toBeDefined();
			expect(pulled.branches?.staging).toBeDefined();

			// 3. Second push with identical config: no mutations.
			const second = await pushConfig(baseConfig, { api, projectId });
			expect(second.conflicts).toHaveLength(0);
			expect(
				second.applied.filter((a) => a.action !== "noop"),
			).toHaveLength(0);
		},
	);

	e2eTest(
		"push without a resolvable projectId throws MissingContextError instead of creating",
		async () => {
			const scope = await detectApiKeyScope();
			if (scope.kind !== "org-or-user") return;

			const api = makeRealApi();
			// No projectId / NEON_PROJECT_ID / context file in cwd — push must refuse.
			await expect(
				pushConfig(
					defineConfig({
						project: {
							name: uniqueProjectName("no-bootstrap"),
							region: DEFAULT_REGION,
						},
						branches: { production: {} },
					}),
					{ api, cwd: "/tmp" },
				),
			).rejects.toBeInstanceOf(errors.MissingContextError);
		},
	);

	e2eTest(
		"project-scoped key path: getProject works against an already-existing project",
		async ({ track }) => {
			const scope = await detectApiKeyScope();
			const api = makeRealApi();

			let projectId: string;
			if (scope.kind === "org-or-user") {
				projectId = await bootstrapProject(api, {
					name: uniqueProjectName("byid"),
					region: DEFAULT_REGION,
				});
				track(projectId);
			} else {
				projectId = scope.projectId;
			}

			// The "project-scoped" path inside pushConfig — projectId supplied, listProjects
			// is never called.
			const pulled = await pullConfig({ api, projectId });
			const result = await pushConfig(pulled, { api, projectId });
			expect(result.projectId).toBe(projectId);
			expect(result.conflicts).toHaveLength(0);
		},
	);
});
