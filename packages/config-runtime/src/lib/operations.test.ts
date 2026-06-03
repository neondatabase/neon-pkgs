import { defineConfig, ErrorCode } from "@neondatabase/config";
import { describe, expect, test } from "vitest";
import { FakeNeonApi } from "./fake-neon-api.js";
import { apply, inspect, plan } from "./operations.js";

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
		const config = defineConfig(() => ({ auth: {} }));
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
		const config = defineConfig(() => ({ auth: {} }));
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
		const config = defineConfig(() => ({
			postgres: { computeSettings: { autoscalingLimitMaxCu: 4 } },
		}));
		await expect(
			apply(config, { api, projectId, branchId: "br-main" }),
		).rejects.toMatchObject({ code: ErrorCode.PushConflict });
	});

	test("applies drift to a protected branch with both override flags", async () => {
		const { api, projectId } = seededFake({ protected: true });
		const config = defineConfig(() => ({
			postgres: { computeSettings: { autoscalingLimitMaxCu: 4 } },
		}));
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

describe("branch not found (id-only lookup)", () => {
	test("inspect throws BranchNotFound for an unknown id", async () => {
		const { api, projectId } = seededFake();
		await expect(
			inspect({ api, projectId, branchId: "br-does-not-exist" }),
		).rejects.toMatchObject({ code: ErrorCode.BranchNotFound });
	});

	test("plan throws BranchNotFound for an unknown id", async () => {
		const { api, projectId } = seededFake();
		const config = defineConfig(() => ({}));
		await expect(
			plan(config, { api, projectId, branchId: "br-does-not-exist" }),
		).rejects.toMatchObject({ code: ErrorCode.BranchNotFound });
	});

	test("apply throws BranchNotFound for an unknown id", async () => {
		const { api, projectId } = seededFake();
		const config = defineConfig(() => ({}));
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
