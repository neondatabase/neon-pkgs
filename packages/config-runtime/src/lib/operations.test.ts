import { defineConfig, ErrorCode } from "@neon/config";
import { describe, expect, test } from "vitest";
import { FakeNeonApi } from "./fake-neon-api.js";
import { apply, createBranch, inspect, plan } from "./operations.js";

function seededFake(opts?: { protected?: boolean }) {
	const api = new FakeNeonApi();
	const projectId = "proj-ops";
	api.seedProject({
		project: {
			id: projectId,
			name: "ops-test",
			regionId: "aws-us-east-1",
			pgVersion: 17,
			orgId: "org-ops",
		},
		branches: [
			{
				branch: {
					id: "br-main",
					name: "main",
					isDefault: true,
					protected: opts?.protected ?? false,
				},
			},
		],
	});
	return { api, projectId };
}

describe("inspect", () => {
	test("returns the selected branch's live state", async () => {
		const { api, projectId } = seededFake();
		const result = await inspect({ api, projectId, branchId: "br-main" });
		expect(result.project.name).toBe("ops-test");
		expect(result.branch.name).toBe("main");
		expect(result.config).toBeDefined();
	});
});

describe("plan", () => {
	test("computes a dry-run plan without mutating", async () => {
		const { api, projectId } = seededFake();
		const config = defineConfig({ auth: {} });
		const result = await plan(config, {
			api,
			projectId,
			branchId: "br-main",
		});
		expect(result.dryRun).toBe(true);
		expect(result.applied).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					kind: "service",
					identifier: "auth",
				}),
			]),
		);
		// No mutation happened: a fresh plan still shows the same enable.
		const again = await plan(config, {
			api,
			projectId,
			branchId: "br-main",
		});
		expect(again.applied).toEqual(result.applied);
	});
});

describe("apply", () => {
	test("applies the branch policy to the selected branch", async () => {
		const { api, projectId } = seededFake();
		const config = defineConfig({ auth: {} });
		const result = await apply(config, {
			api,
			projectId,
			branchId: "br-main",
			updateExisting: true,
		});
		expect(result.dryRun).toBe(false);
		expect(result.applied).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					kind: "service",
					identifier: "auth",
				}),
			]),
		);
	});

	test("surfaces drift as a PushConflictError without updateExisting", async () => {
		const { api, projectId } = seededFake();
		const config = defineConfig({
			branch: () => ({
				postgres: { computeSettings: { autoscalingLimitMaxCu: 4 } },
			}),
		});
		await expect(
			apply(config, { api, projectId, branchId: "br-main" }),
		).rejects.toMatchObject({ code: ErrorCode.PushConflict });
	});

	test("applies drift to a protected branch with both override flags", async () => {
		const { api, projectId } = seededFake({ protected: true });
		const config = defineConfig({
			branch: () => ({
				postgres: { computeSettings: { autoscalingLimitMaxCu: 4 } },
			}),
		});
		const result = await apply(config, {
			api,
			projectId,
			branchId: "br-main",
			updateExisting: true,
			allowProtectedBranch: true,
		});
		expect(result.dryRun).toBe(false);
		expect(api.history.some((h) => h.method === "updateEndpoint")).toBe(
			true,
		);
	});
});

describe("createBranch", () => {
	// Mirrors the reported neonctl checkout policy: settings are gated on a *new* branch.
	const devPolicy = defineConfig({
		auth: true,
		dataApi: true,
		branch: (branch) => {
			if (branch.exists) return {};
			if (branch.name.startsWith("dev")) {
				return {
					ttl: "7d",
					postgres: {
						computeSettings: {
							autoscalingLimitMinCu: 0.25,
							autoscalingLimitMaxCu: 1,
							suspendTimeout: "5m",
						},
					},
				};
			}
			return {};
		},
	});

	test("applies creation-time tuning gated on !branch.exists", async () => {
		const { api, projectId } = seededFake();
		const { branchId, branchName, result } = await createBranch(devPolicy, {
			api,
			projectId,
			branchName: "dev-1",
		});

		expect(branchName).toBe("dev-1");

		// TTL was applied (branch has an expiry).
		const branches = await api.listBranches(projectId);
		const created = branches.find((b) => b.id === branchId);
		expect(created?.expiresAt).toBeDefined();

		// Compute settings from the policy landed on the new branch's endpoint.
		const endpoints = await api.listEndpoints(projectId);
		const endpoint = endpoints.find((e) => e.branchId === branchId);
		expect(endpoint?.autoscalingLimitMaxCu).toBe(1);
		expect(endpoint?.suspendTimeout).toBe("5m");

		// Services declared at the top level were enabled too.
		expect(result.applied).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					kind: "service",
					identifier: "auth",
				}),
				expect.objectContaining({
					kind: "service",
					identifier: "dataApi",
				}),
			]),
		);
	});

	test("branches from the policy's parent", async () => {
		const { api, projectId } = seededFake();
		const main = (await api.listBranches(projectId)).find(
			(b) => b.isDefault,
		);
		const config = defineConfig({
			branch: (branch) =>
				branch.exists ? {} : { parent: "main", ttl: "1d" },
		});
		const { branchId } = await createBranch(config, {
			api,
			projectId,
			branchName: "dev-from-main",
		});
		const created = (await api.listBranches(projectId)).find(
			(b) => b.id === branchId,
		);
		expect(created?.parentId).toBe(main?.id);
	});

	test("throws when the policy names a parent that does not exist", async () => {
		const { api, projectId } = seededFake();
		const config = defineConfig({
			branch: (branch) => (branch.exists ? {} : { parent: "nope" }),
		});
		await expect(
			createBranch(config, { api, projectId, branchName: "dev-x" }),
		).rejects.toMatchObject({ code: ErrorCode.BranchNotFound });
	});

	test("throws when the branch name already exists", async () => {
		const { api, projectId } = seededFake();
		await expect(
			createBranch(defineConfig({}), {
				api,
				projectId,
				branchName: "main",
			}),
		).rejects.toMatchObject({ code: ErrorCode.Conflict });
	});
});

describe("branch not found (id-only lookup)", () => {
	test("inspect throws BranchNotFound for an unknown id", async () => {
		const { api, projectId } = seededFake();
		await expect(
			inspect({ api, projectId, branchId: "br-does-not-exist" }),
		).rejects.toMatchObject({ code: ErrorCode.BranchNotFound });
	});

	test("plan throws BranchNotFound for an unknown id", async () => {
		const { api, projectId } = seededFake();
		const config = defineConfig({});
		await expect(
			plan(config, { api, projectId, branchId: "br-does-not-exist" }),
		).rejects.toMatchObject({ code: ErrorCode.BranchNotFound });
	});

	test("apply throws BranchNotFound for an unknown id", async () => {
		const { api, projectId } = seededFake();
		const config = defineConfig({});
		await expect(
			apply(config, { api, projectId, branchId: "br-does-not-exist" }),
		).rejects.toMatchObject({ code: ErrorCode.BranchNotFound });
	});

	test("inspect rejects a branch name (ids only)", async () => {
		const { api, projectId } = seededFake();
		// "main" is the branch NAME; lookups match by id only, so this must fail.
		await expect(
			inspect({ api, projectId, branchId: "main" }),
		).rejects.toMatchObject({ code: ErrorCode.BranchNotFound });
	});
});
