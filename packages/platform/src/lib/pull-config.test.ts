import { describe, expect, test } from "vitest";
import { FakeNeonApi } from "./fake-neon-api.js";
import { pullConfig } from "./pull-config.js";

describe("pullConfig", () => {
	test("returns a Config that round-trips through defineConfig", async () => {
		const api = new FakeNeonApi();
		api.seedProject({
			project: {
				id: "proj-1",
				name: "my-app",
				regionId: "aws-us-east-1",
				pgVersion: 17,
				orgId: "org-1",
				defaultEndpointSettings: {
					autoscalingLimitMinCu: 0.25,
					autoscalingLimitMaxCu: 1,
					suspendTimeout: 300,
				},
			},
			branches: [
				{
					branch: {
						id: "br-prod",
						name: "production",
						isDefault: true,
					},
				},
				{
					branch: {
						id: "br-staging",
						name: "staging",
						isDefault: false,
						parentId: "br-prod",
					},
					endpoint: {
						autoscalingLimitMaxCu: 2,
						autoscalingLimitMinCu: 0.25,
						suspendTimeout: 300,
					},
				},
			],
		});

		const config = await pullConfig({ projectId: "proj-1", api });
		expect(config.project).toEqual({
			name: "my-app",
			region: "aws-us-east-1",
			pgVersion: 17,
		});
		expect(config.branches?.production).toBeDefined();
		// `parent: "production"` is elided on emit because it's the default; resolveConfig
		// fills it back in. The compute drift (max=2 vs project default max=1) is captured.
		expect(config.branches?.staging).toEqual({
			computeSettings: { autoscalingLimitMaxCu: 2 },
		});
		// Blueprints are templates that live in your editable `neon.ts`; pull never
		// emits a `branchBlueprints` section.
		expect(config.branchBlueprints).toBeUndefined();
	});

	test("drops ephemeral branches with a future expires_at — those are runtime, not config", async () => {
		const api = new FakeNeonApi();
		const expiresAt = new Date(Date.now() + 3600 * 1000).toISOString();
		api.seedProject({
			project: {
				id: "proj-2",
				name: "my-app",
				regionId: "aws-us-east-1",
				pgVersion: 17,
			},
			branches: [
				{
					branch: {
						id: "br-prod",
						name: "production",
						isDefault: true,
					},
				},
				{
					branch: {
						id: "br-eph",
						name: "preview-eph",
						isDefault: false,
						parentId: "br-prod",
						expiresAt,
					},
				},
			],
		});
		const config = await pullConfig({ projectId: "proj-2", api });
		expect(Object.keys(config.branches ?? {})).toEqual(["production"]);
	});

	test("emits the `protected` flag for protected branches", async () => {
		const api = new FakeNeonApi();
		api.seedProject({
			project: {
				id: "proj-prot",
				name: "my-app",
				regionId: "aws-us-east-1",
				pgVersion: 17,
			},
			branches: [
				{
					branch: {
						id: "br-prod",
						name: "production",
						isDefault: true,
						protected: true,
					},
				},
			],
		});
		const config = await pullConfig({ projectId: "proj-prot", api });
		expect(config.branches?.production.protected).toBe(true);
	});

	test("does not emit compute settings when they match project defaults", async () => {
		const api = new FakeNeonApi();
		api.seedProject({
			project: {
				id: "proj-3",
				name: "my-app",
				regionId: "aws-us-east-1",
				pgVersion: 17,
				defaultEndpointSettings: {
					autoscalingLimitMinCu: 0.25,
					autoscalingLimitMaxCu: 0.25,
					suspendTimeout: 0,
				},
			},
		});
		const config = await pullConfig({ projectId: "proj-3", api });
		expect(config.branches?.production.computeSettings).toBeUndefined();
	});

	test("falls back to .neon/project.json when no projectId passed", async () => {
		const api = new FakeNeonApi();
		api.seedProject({
			project: {
				id: "proj-5",
				name: "my-app",
				regionId: "aws-us-east-1",
				pgVersion: 17,
			},
		});
		const { makeTempRepo } = await import("./test-utils.js");
		const repo = makeTempRepo({
			"package.json": "{}",
			".neon/project.json": JSON.stringify({ projectId: "proj-5" }),
		});
		try {
			const config = await pullConfig({ api, cwd: repo.root });
			expect(config.project.name).toBe("my-app");
		} finally {
			repo.cleanup();
		}
	});
});
