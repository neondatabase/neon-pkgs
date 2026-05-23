import { describe, expect, test } from "vitest";
import { defineConfig, resolveConfig } from "./define-config.js";
import { diffConfig, type RemoteState } from "./diff.js";
import type {
	NeonBranchSnapshot,
	NeonEndpointSnapshot,
	NeonProjectSnapshot,
} from "./neon-api.js";

function makeRemote(args?: {
	project?: Partial<NeonProjectSnapshot>;
	branches?: NeonBranchSnapshot[];
	endpoints?: NeonEndpointSnapshot[];
}): RemoteState {
	const project: NeonProjectSnapshot = {
		id: "proj-1",
		name: "my-app",
		regionId: "aws-us-east-1",
		pgVersion: 17,
		...args?.project,
	};
	const branches: NeonBranchSnapshot[] = args?.branches ?? [
		{
			id: "br-prod",
			name: "production",
			isDefault: true,
			protected: false,
		},
	];
	const endpoints: NeonEndpointSnapshot[] = args?.endpoints ?? [
		{
			id: "ep-prod",
			branchId: "br-prod",
			type: "read_write",
			autoscalingLimitMinCu: 0.25,
			autoscalingLimitMaxCu: 0.25,
			suspendTimeout: 0,
		},
	];
	return { project, branches, endpoints };
}

describe("diffConfig — project diff", () => {
	test("reports name mismatch as conflict", () => {
		const config = resolveConfig(
			defineConfig({ project: { name: "other" } }),
		);
		const result = diffConfig(config, makeRemote(), {
			applyExisting: false,
			updateExisting: false,
		});
		expect(result.conflicts).toEqual([
			expect.objectContaining({
				kind: "project",
				field: "name",
				current: "my-app",
				desired: "other",
			}),
		]);
	});

	test("reports region mismatch as conflict (immutable)", () => {
		const config = resolveConfig(
			defineConfig({
				project: { name: "my-app", region: "aws-us-west-2" },
			}),
		);
		const result = diffConfig(config, makeRemote(), {
			applyExisting: false,
			updateExisting: false,
		});
		expect(result.conflicts.some((c) => c.field === "region")).toBe(true);
	});

	test("normalizes region before comparing", () => {
		const config = resolveConfig(
			defineConfig({ project: { name: "my-app", region: "us-east-1" } }),
		);
		const result = diffConfig(config, makeRemote(), {
			applyExisting: false,
			updateExisting: false,
		});
		expect(
			result.conflicts.find((c) => c.field === "region"),
		).toBeUndefined();
	});

	test("reports pgVersion mismatch as conflict", () => {
		const config = resolveConfig(
			defineConfig({ project: { name: "my-app", pgVersion: 15 } }),
		);
		const result = diffConfig(config, makeRemote(), {
			applyExisting: false,
			updateExisting: false,
		});
		expect(result.conflicts.some((c) => c.field === "pgVersion")).toBe(
			true,
		);
	});
});

describe("diffConfig — concrete branches", () => {
	test("plans create when branch missing (always allowed)", () => {
		const config = resolveConfig(
			defineConfig({
				project: { name: "my-app" },
				branches: {
					production: {},
					staging: { parent: "production" },
				},
			}),
		);
		const result = diffConfig(config, makeRemote(), {
			applyExisting: false,
			updateExisting: false,
		});
		expect(result.plan).toEqual([
			expect.objectContaining({
				kind: "create-branch",
				branchName: "staging",
				parentBranchName: "production",
			}),
		]);
		expect(result.conflicts).toHaveLength(0);
	});

	test("reports compute drift as conflict when updateExisting is false", () => {
		const config = resolveConfig(
			defineConfig({
				project: { name: "my-app" },
				branches: {
					production: {
						computeSettings: { autoscalingLimitMaxCu: 2 },
					},
				},
			}),
		);
		const result = diffConfig(config, makeRemote(), {
			applyExisting: false,
			updateExisting: false,
		});
		expect(result.plan).toHaveLength(0);
		expect(result.conflicts).toEqual([
			expect.objectContaining({
				kind: "branch",
				identifier: "production",
				field: "computeSettings",
			}),
		]);
	});

	test("plans an endpoint update when updateExisting is true", () => {
		const config = resolveConfig(
			defineConfig({
				project: { name: "my-app" },
				branches: {
					production: {
						computeSettings: { autoscalingLimitMaxCu: 2 },
					},
				},
			}),
		);
		const result = diffConfig(config, makeRemote(), {
			applyExisting: false,
			updateExisting: true,
		});
		expect(result.conflicts).toHaveLength(0);
		expect(result.plan).toEqual([
			expect.objectContaining({
				kind: "update-endpoint",
				endpointId: "ep-prod",
				settings: { autoscalingLimitMaxCu: 2 },
			}),
		]);
	});

	test("reports `protected` drift as conflict by default", () => {
		const remote = makeRemote();
		const config = resolveConfig(
			defineConfig({
				project: { name: "my-app" },
				branches: { production: { protected: true } },
			}),
		);
		const result = diffConfig(config, remote, {
			applyExisting: false,
			updateExisting: false,
		});
		expect(result.conflicts.some((c) => c.field === "protected")).toBe(
			true,
		);
	});

	test("plans a protected toggle when updateExisting is true", () => {
		const remote = makeRemote();
		const config = resolveConfig(
			defineConfig({
				project: { name: "my-app" },
				branches: { production: { protected: true } },
			}),
		);
		const result = diffConfig(config, remote, {
			applyExisting: false,
			updateExisting: true,
		});
		expect(result.plan).toEqual([
			expect.objectContaining({
				kind: "update-branch-protected",
				branchId: "br-prod",
				protected: true,
			}),
		]);
	});

	test("applies `protected: true` on create", () => {
		const config = resolveConfig(
			defineConfig({
				project: { name: "my-app" },
				branches: {
					production: {},
					staging: { parent: "production", protected: true },
				},
			}),
		);
		const result = diffConfig(config, makeRemote(), {
			applyExisting: false,
			updateExisting: false,
		});
		expect(result.plan).toEqual([
			expect.objectContaining({
				kind: "create-branch",
				branchName: "staging",
				protected: true,
			}),
		]);
	});

	test("missing parent branch is a conflict, not a silent failure", () => {
		const config = resolveConfig(
			defineConfig({
				project: { name: "my-app" },
				branches: {
					production: {},
					feature: { parent: "does-not-exist" },
				},
			}),
		);
		const result = diffConfig(config, makeRemote(), {
			applyExisting: false,
			updateExisting: false,
		});
		expect(result.conflicts).toEqual([
			expect.objectContaining({
				kind: "branch",
				identifier: "feature",
				field: "parent",
			}),
		]);
	});
});

describe("diffConfig — wildcard blueprint", () => {
	test("skips wildcard updates by default and records them", () => {
		const remote = makeRemote({
			branches: [
				{
					id: "br-prod",
					name: "production",
					isDefault: true,
					protected: false,
				},
				{
					id: "br-p1",
					name: "preview-pr-1",
					isDefault: false,
					protected: false,
					parentId: "br-prod",
				},
				{
					id: "br-p2",
					name: "preview-pr-2",
					isDefault: false,
					protected: false,
					parentId: "br-prod",
				},
			],
			endpoints: [
				{
					id: "ep-prod",
					branchId: "br-prod",
					type: "read_write",
					autoscalingLimitMinCu: 0.25,
					autoscalingLimitMaxCu: 0.25,
					suspendTimeout: 0,
				},
				{
					id: "ep-p1",
					branchId: "br-p1",
					type: "read_write",
					autoscalingLimitMinCu: 0.25,
					autoscalingLimitMaxCu: 0.25,
					suspendTimeout: 0,
				},
				{
					id: "ep-p2",
					branchId: "br-p2",
					type: "read_write",
					autoscalingLimitMinCu: 0.25,
					autoscalingLimitMaxCu: 0.25,
					suspendTimeout: 0,
				},
			],
		});
		const config = resolveConfig(
			defineConfig({
				project: { name: "my-app" },
				branches: { production: {} },
				branchBlueprints: {
					preview: {
						pattern: "preview-*",
						ttl: "1h",
						computeSettings: { autoscalingLimitMaxCu: 1 },
					},
				},
			}),
		);
		const result = diffConfig(config, remote, {
			applyExisting: false,
			updateExisting: false,
		});
		expect(result.plan).toHaveLength(0);
		expect(result.conflicts).toHaveLength(0);
		expect(result.skippedWildcardBranches).toEqual([
			{
				pattern: "preview-*",
				branches: ["preview-pr-1", "preview-pr-2"],
			},
		]);
	});

	test("with applyExisting=true, plans endpoint and TTL updates for matching branches", () => {
		const remote = makeRemote({
			branches: [
				{
					id: "br-prod",
					name: "production",
					isDefault: true,
					protected: false,
				},
				{
					id: "br-p1",
					name: "preview-pr-1",
					isDefault: false,
					protected: false,
					parentId: "br-prod",
				},
			],
			endpoints: [
				{
					id: "ep-prod",
					branchId: "br-prod",
					type: "read_write",
					autoscalingLimitMinCu: 0.25,
					autoscalingLimitMaxCu: 0.25,
					suspendTimeout: 0,
				},
				{
					id: "ep-p1",
					branchId: "br-p1",
					type: "read_write",
					autoscalingLimitMinCu: 0.25,
					autoscalingLimitMaxCu: 0.25,
					suspendTimeout: 0,
				},
			],
		});
		const config = resolveConfig(
			defineConfig({
				project: { name: "my-app" },
				branches: { production: {} },
				branchBlueprints: {
					preview: {
						pattern: "preview-*",
						ttl: "1h",
						computeSettings: { autoscalingLimitMaxCu: 1 },
					},
				},
			}),
		);
		const result = diffConfig(config, remote, {
			applyExisting: true,
			updateExisting: false,
		});
		expect(result.skippedWildcardBranches).toHaveLength(0);
		expect(result.plan).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					kind: "update-endpoint",
					endpointId: "ep-p1",
				}),
				expect.objectContaining({
					kind: "update-branch-ttl",
					branchId: "br-p1",
				}),
			]),
		);
	});

	test("default branch is excluded from wildcard match even when it matches", () => {
		const remote = makeRemote({
			project: { name: "my-app" },
			branches: [
				{
					id: "br-prod",
					name: "preview-default",
					isDefault: true,
					protected: false,
				},
			],
			endpoints: [
				{
					id: "ep-prod",
					branchId: "br-prod",
					type: "read_write",
					autoscalingLimitMinCu: 0.25,
					autoscalingLimitMaxCu: 0.25,
					suspendTimeout: 0,
				},
			],
		});
		const config = resolveConfig(
			defineConfig({
				project: { name: "my-app" },
				branchBlueprints: {
					preview: {
						pattern: "preview-*",
						computeSettings: { autoscalingLimitMaxCu: 1 },
					},
				},
			}),
		);
		const result = diffConfig(config, remote, {
			applyExisting: true,
			updateExisting: false,
		});
		expect(result.plan).toHaveLength(0);
		expect(result.skippedWildcardBranches).toHaveLength(0);
	});
});

describe("diffConfig — features", () => {
	function remoteWithFeatures(args: {
		auth?: { projectId: string; jwksUrl: string } | null;
		dataApi?: { url: string } | null;
	}) {
		const base = makeRemote();
		base.features = {
			branchId: "br-prod",
			branchName: "production",
			databaseName: "neondb",
			auth: args.auth ?? null,
			dataApi: args.dataApi ?? null,
		};
		return base;
	}

	test("plans `enable-auth` when features.auth=true and remote has none", () => {
		const config = resolveConfig(
			defineConfig({
				project: { name: "my-app" },
				branches: { production: {} },
				features: { auth: true },
			}),
		);
		const result = diffConfig(config, remoteWithFeatures({}), {
			applyExisting: false,
			updateExisting: false,
		});
		expect(result.plan).toEqual([
			expect.objectContaining({
				kind: "enable-auth",
				branchId: "br-prod",
				branchName: "production",
			}),
		]);
		expect(result.conflicts).toHaveLength(0);
	});

	test("plans `enable-data-api` when features.dataApi=true and remote has none", () => {
		const config = resolveConfig(
			defineConfig({
				project: { name: "my-app" },
				branches: { production: {} },
				features: { dataApi: true },
			}),
		);
		const result = diffConfig(config, remoteWithFeatures({}), {
			applyExisting: false,
			updateExisting: false,
		});
		expect(result.plan).toEqual([
			expect.objectContaining({
				kind: "enable-data-api",
				branchId: "br-prod",
				branchName: "production",
				databaseName: "neondb",
			}),
		]);
	});

	test("noop when integrations are already enabled remotely", () => {
		const config = resolveConfig(
			defineConfig({
				project: { name: "my-app" },
				branches: { production: {} },
				features: { auth: true, dataApi: true },
			}),
		);
		const result = diffConfig(
			config,
			remoteWithFeatures({
				auth: { projectId: "neon-auth-x", jwksUrl: "https://j.tld" },
				dataApi: { url: "https://d.tld" },
			}),
			{ applyExisting: false, updateExisting: false },
		);
		expect(result.plan).toHaveLength(0);
		expect(result.conflicts).toHaveLength(0);
	});

	test("does not plan disable when feature is false but remote integration exists", () => {
		// Disabling is destructive (drops `neon_auth.*` schema, kills public REST endpoint),
		// so push leaves remote integrations alone. The user has to tear them down via the
		// Neon console explicitly.
		const config = resolveConfig(
			defineConfig({
				project: { name: "my-app" },
				branches: { production: {} },
				features: { auth: false, dataApi: false },
			}),
		);
		const result = diffConfig(
			config,
			remoteWithFeatures({
				auth: { projectId: "neon-auth-x", jwksUrl: "https://j.tld" },
				dataApi: { url: "https://d.tld" },
			}),
			{ applyExisting: false, updateExisting: false },
		);
		expect(result.plan).toHaveLength(0);
		expect(result.conflicts).toHaveLength(0);
	});

	test("plans nothing when config.features is undefined / not set", () => {
		const config = resolveConfig(
			defineConfig({
				project: { name: "my-app" },
				branches: { production: {} },
			}),
		);
		// Pass remote with feature state — diff still ignores it because config.features is unset.
		const result = diffConfig(config, remoteWithFeatures({}), {
			applyExisting: false,
			updateExisting: false,
		});
		expect(result.plan).toHaveLength(0);
	});
});
