import {
	type CreateBranchInput,
	defineConfig,
	ErrorCode,
	isPartialBranchCreateError,
} from "@neon/config";
import { describe, expect, test } from "vitest";
import { FakeNeonApi } from "./fake-neon-api.js";
import { apply, createBranch, inspect, plan } from "./operations.js";

/** What Neon rejects a plan-gated compute setting with (seen live on a Free-plan project). */
const SUSPEND_REJECTED =
	'HTTP 412. Neon API said: "modifying the suspend interval is not permitted on this account".';
const AUTH_REJECTED = "Neon Auth is not available on this account";

/**
 * Accepts the create call but drops the compute settings it carried — an API that ignores the
 * field, which is what leaves drift for the push to fix.
 */
class IgnoresCreateComputeApi extends FakeNeonApi {
	override async createBranch(projectId: string, input: CreateBranchInput) {
		const { computeSettings, ...rest } = input;
		void computeSettings;
		return super.createBranch(projectId, rest);
	}
}

/** Rejects the create call outright, the way Neon rejects a setting the plan doesn't allow. */
class RejectsCreateApi extends FakeNeonApi {
	override async createBranch(): Promise<never> {
		throw new Error(SUSPEND_REJECTED);
	}
}

/** Creates the branch, then fails to provision the service the policy declares. */
class RejectsAuthApi extends FakeNeonApi {
	override async enableNeonAuth(): Promise<never> {
		throw new Error(AUTH_REJECTED);
	}
}

function seededFake(opts?: { protected?: boolean }) {
	return seedProjectOn(new FakeNeonApi(), opts);
}

/** Seed the shared project/branch layout onto a specific fake, preserving its subclass type. */
function seedProjectOn<T extends FakeNeonApi>(
	api: T,
	opts?: { protected?: boolean },
): { api: T; projectId: string } {
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

	test("carries every creation-time setting on the create call itself", async () => {
		// The point of the single call: Neon validates parent/expiry/protected/compute
		// together, so a value it rejects fails the creation instead of leaving a branch
		// behind. Anything sent afterwards would reopen that window.
		const { api, projectId } = seededFake();
		const config = defineConfig({
			branch: (branch) =>
				branch.exists
					? {}
					: {
							parent: "main",
							ttl: "1d",
							protected: true,
							postgres: {
								computeSettings: { autoscalingLimitMaxCu: 4 },
							},
						},
		});

		await createBranch(config, { api, projectId, branchName: "dev-all" });

		const create = api.history.find((h) => h.method === "createBranch");
		expect(create?.args[1]).toMatchObject({
			name: "dev-all",
			parentId: "br-main",
			protected: true,
			computeSettings: { autoscalingLimitMaxCu: 4 },
		});
		expect(create?.args[1]).toHaveProperty("expiresAt", expect.any(String));
	});

	test("leaves nothing for a follow-up branch or endpoint update", async () => {
		const { api, projectId } = seededFake();
		const config = defineConfig({
			branch: (branch) =>
				branch.exists
					? {}
					: {
							ttl: "1d",
							protected: true,
							postgres: {
								computeSettings: { autoscalingLimitMaxCu: 4 },
							},
						},
		});

		await createBranch(config, { api, projectId, branchName: "dev-once" });

		expect(api.history.map((h) => h.method)).not.toContain("updateBranch");
		expect(api.history.map((h) => h.method)).not.toContain(
			"updateEndpoint",
		);
	});

	test("reports the settings the create call applied", async () => {
		// Applying a setting at creation instead of in a follow-up call must not make it
		// disappear from the summary, so these are reported like any other applied change.
		const { api, projectId } = seededFake();
		const config = defineConfig({
			branch: (branch) =>
				branch.exists
					? {}
					: {
							parent: "main",
							ttl: "1d",
							protected: true,
							postgres: {
								computeSettings: { autoscalingLimitMaxCu: 4 },
							},
						},
		});

		const { result } = await createBranch(config, {
			api,
			projectId,
			branchName: "dev-report",
		});

		// Non-noop only: the push contributes a `noop` for the branch whose settings already
		// match (they were applied at creation), and reporting filters those out.
		const branchChanges = result.applied.filter(
			(c) => c.kind === "branch" && c.action !== "noop",
		);
		expect(branchChanges).toEqual([
			{
				kind: "branch",
				action: "create",
				identifier: "dev-report",
				details: { field: "parent", parent: "main" },
			},
			{
				kind: "branch",
				action: "create",
				identifier: "dev-report",
				details: { field: "ttl", expiresAt: expect.any(String) },
			},
			{
				kind: "branch",
				action: "create",
				identifier: "dev-report",
				details: { field: "protected", protected: true },
			},
			{
				kind: "branch",
				action: "create",
				identifier: "dev-report",
				details: {
					field: "computeSettings",
					settings: { autoscalingLimitMaxCu: 4 },
				},
			},
		]);
	});

	test("reports no branch settings for a policy that declares none", async () => {
		// Services only: nothing was tuned at creation, so nothing is claimed to be.
		const { api, projectId } = seededFake();
		const { result } = await createBranch(defineConfig({ auth: true }), {
			api,
			projectId,
			branchName: "dev-services",
		});

		expect(
			result.applied.filter(
				(c) => c.kind === "branch" && c.action !== "noop",
			),
		).toEqual([]);
		expect(result.applied).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					kind: "service",
					identifier: "auth",
				}),
			]),
		);
	});

	test("does not claim a parent the policy never named", async () => {
		// Falling back to the project's default branch isn't a policy decision, so reporting
		// it as one would put a `parent` line in the summary the user never asked for.
		const { api, projectId } = seededFake();
		const config = defineConfig({
			branch: (branch) => (branch.exists ? {} : { ttl: "1d" }),
		});

		const { result } = await createBranch(config, {
			api,
			projectId,
			branchName: "dev-default-parent",
		});

		expect(
			result.applied.filter((c) => c.details?.field === "parent"),
		).toEqual([]);
	});

	test("reports a setting the create call did not take exactly once", async () => {
		// An API that accepts the create-time compute but doesn't apply it leaves drift for
		// the push to fix. The push change is what actually happened, so it must supersede
		// the create-time claim rather than being listed alongside it.
		const { api, projectId } = seedProjectOn(new IgnoresCreateComputeApi());
		const config = defineConfig({
			branch: (branch) =>
				branch.exists
					? {}
					: {
							postgres: {
								computeSettings: { autoscalingLimitMaxCu: 4 },
							},
						},
		});

		const { result } = await createBranch(config, {
			api,
			projectId,
			branchName: "dev-drift",
		});

		const compute = result.applied.filter(
			(c) => c.details?.field === "computeSettings",
		);
		expect(compute).toHaveLength(1);
		expect(compute[0]?.action).toBe("update");
		expect(api.history.map((h) => h.method)).toContain("updateEndpoint");
	});

	test("a setting Neon rejects fails the creation with no branch left behind", async () => {
		// The whole reason the settings ride along on the create call: the failure happens
		// before anything exists, so there is nothing half-configured to clean up and the
		// caller sees the API's own error rather than a partial-create.
		const { api, projectId } = seedProjectOn(new RejectsCreateApi());
		const config = defineConfig({
			branch: (branch) =>
				branch.exists
					? {}
					: {
							postgres: {
								computeSettings: { suspendTimeout: "5m" },
							},
						},
		});

		const error = await createBranch(config, {
			api,
			projectId,
			branchName: "dev-rejected",
		}).catch((err: unknown) => err);

		expect(isPartialBranchCreateError(error)).toBe(false);
		expect((error as Error).message).toContain(SUSPEND_REJECTED);
		expect((await api.listBranches(projectId)).map((b) => b.name)).toEqual([
			"main",
		]);
	});

	test("a service that fails after creation still reports the created branch", async () => {
		// Services have no create-time equivalent, so this window stays open: the branch is
		// real and its id has to survive the failure for the caller to pin and report it.
		const { api, projectId } = seedProjectOn(new RejectsAuthApi());

		const error = await createBranch(defineConfig({ auth: true }), {
			api,
			projectId,
			branchName: "dev-service-fail",
		}).catch((err: unknown) => err);

		expect(isPartialBranchCreateError(error)).toBe(true);
		if (!isPartialBranchCreateError(error)) return;
		expect(error.branchName).toBe("dev-service-fail");
		expect(error.reason).toContain(AUTH_REJECTED);
		const branch = (await api.listBranches(projectId)).find(
			(b) => b.id === error.branchId,
		);
		expect(branch?.name).toBe("dev-service-fail");
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
