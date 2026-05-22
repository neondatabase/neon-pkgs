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
					suspendTimeoutSeconds: 300,
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
						suspendTimeoutSeconds: 300,
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
		expect(config.branchBlueprints?.production).toBeDefined();
		// `parent: "production"` is elided on emit because it's the default; resolveConfig
		// fills it back in. The compute drift (max=2 vs project default max=1) is captured.
		expect(config.branchBlueprints?.staging).toEqual({
			computeSettings: { autoscalingLimitMaxCu: 2 },
		});
	});

	test("emits TTL when branch has an expires_at in the future", async () => {
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
						name: "ephemeral",
						isDefault: false,
						parentId: "br-prod",
						expiresAt,
					},
				},
			],
		});
		const config = await pullConfig({ projectId: "proj-2", api });
		const blueprint = config.branchBlueprints?.ephemeral;
		expect(blueprint?.ttl).toBeDefined();
		// TTL should be roughly 1h; allow some skew since we just constructed it.
		expect(blueprint?.ttl).toMatch(/^(3[5-6]\d{2}s|1h)$/);
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
					suspendTimeoutSeconds: 0,
				},
			},
		});
		const config = await pullConfig({ projectId: "proj-3", api });
		expect(
			config.branchBlueprints?.production.computeSettings,
		).toBeUndefined();
	});

	test("sanitises branch names that are not legal blueprint keys", async () => {
		const api = new FakeNeonApi();
		api.seedProject({
			project: {
				id: "proj-4",
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
						id: "br-bad",
						name: "feature/foo",
						isDefault: false,
						parentId: "br-prod",
					},
				},
			],
		});
		const config = await pullConfig({ projectId: "proj-4", api });
		const keys = Object.keys(config.branchBlueprints ?? {});
		expect(keys).toContain("feature_foo");
		expect(config.branchBlueprints?.feature_foo.pattern).toBe(
			"feature/foo",
		);
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
