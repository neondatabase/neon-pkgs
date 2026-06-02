import { describe, expect, test } from "vitest";
import { defineConfig } from "./define-config.js";
import { ErrorCode } from "./errors.js";
import { FakeNeonApi } from "./fake-neon-api.js";
import { pushConfig } from "./push-config.js";

function seededFake(opts?: { protected?: boolean }) {
	const api = new FakeNeonApi();
	const projectId = "proj-push";
	api.seedProject({
		project: {
			id: projectId,
			name: "push-test",
			regionId: "aws-us-east-1",
			pgVersion: 17,
			orgId: "org-push",
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

describe("pushConfig", () => {
	test("applies branch-scoped service enables to the selected branch", async () => {
		const { api, projectId } = seededFake();
		const config = defineConfig((branch) => ({
			postgres: {
				computeSettings: {
					autoscalingLimitMaxCu: branch.name === "main" ? 4 : 1,
				},
			},
			auth: {},
			dataApi: {},
		}));

		const result = await pushConfig(config, {
			api,
			projectId,
			branchId: "br-main",
			updateExisting: true,
		});

		expect(result.branchName).toBe("main");
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
		expect(
			api.history.some(
				(h) => h.method === "enableNeonAuth" && h.args[1] === "br-main",
			),
		).toBe(true);
	});

	test("reports mutable branch drift as conflict without updateExisting", async () => {
		const { api, projectId } = seededFake();
		const config = defineConfig(() => ({
			postgres: { computeSettings: { autoscalingLimitMaxCu: 4 } },
		}));

		await expect(
			pushConfig(config, { api, projectId, branchId: "br-main" }),
		).rejects.toMatchObject({
			code: ErrorCode.PushConflict,
		});
	});

	test("confirm callback applies mutable drift when user accepts", async () => {
		const { api, projectId } = seededFake();
		const config = defineConfig(() => ({
			postgres: { computeSettings: { autoscalingLimitMaxCu: 4 } },
		}));

		const calls: Array<{
			protectedBranch: boolean;
			overrideUpdates: boolean;
		}> = [];
		const result = await pushConfig(config, {
			api,
			projectId,
			branchId: "br-main",
			confirm: (ctx) => {
				calls.push({
					protectedBranch: ctx.protectedBranch,
					overrideUpdates: ctx.overrideUpdates,
				});
				return true;
			},
		});

		expect(calls).toEqual([
			{ protectedBranch: false, overrideUpdates: true },
		]);
		expect(
			result.applied.some(
				(c) =>
					c.kind === "branch" &&
					c.action === "update" &&
					c.identifier === "main",
			),
		).toBe(true);
		expect(api.history.some((h) => h.method === "updateEndpoint")).toBe(
			true,
		);
	});

	test("confirm callback returning false aborts with PushAbortedError", async () => {
		const { api, projectId } = seededFake();
		const config = defineConfig(() => ({
			postgres: { computeSettings: { autoscalingLimitMaxCu: 4 } },
		}));

		await expect(
			pushConfig(config, {
				api,
				projectId,
				branchId: "br-main",
				confirm: () => false,
			}),
		).rejects.toMatchObject({ code: ErrorCode.PushAborted });
		expect(api.history.some((h) => h.method === "updateEndpoint")).toBe(
			false,
		);
	});

	test("protected branch triggers confirm even when no drift", async () => {
		const { api, projectId } = seededFake({ protected: true });
		const config = defineConfig(() => ({ auth: {} }));

		const ctxs: Array<{
			protectedBranch: boolean;
			overrideUpdates: boolean;
		}> = [];
		const result = await pushConfig(config, {
			api,
			projectId,
			branchId: "br-main",
			confirm: (ctx) => {
				ctxs.push({
					protectedBranch: ctx.protectedBranch,
					overrideUpdates: ctx.overrideUpdates,
				});
				return true;
			},
		});

		expect(ctxs).toEqual([
			{ protectedBranch: true, overrideUpdates: false },
		]);
		expect(
			result.applied.some(
				(c) => c.kind === "service" && c.identifier === "auth",
			),
		).toBe(true);
	});

	test("protected branch + drift collapses into a single confirm call", async () => {
		const { api, projectId } = seededFake({ protected: true });
		const config = defineConfig(() => ({
			postgres: { computeSettings: { autoscalingLimitMaxCu: 4 } },
		}));

		const ctxs: Array<{
			protectedBranch: boolean;
			overrideUpdates: boolean;
		}> = [];
		await pushConfig(config, {
			api,
			projectId,
			branchId: "br-main",
			confirm: (ctx) => {
				ctxs.push({
					protectedBranch: ctx.protectedBranch,
					overrideUpdates: ctx.overrideUpdates,
				});
				return true;
			},
		});

		expect(ctxs).toEqual([
			{ protectedBranch: true, overrideUpdates: true },
		]);
	});

	test("allowProtectedBranch + updateExisting skip the confirm callback", async () => {
		const { api, projectId } = seededFake({ protected: true });
		const config = defineConfig(() => ({
			postgres: { computeSettings: { autoscalingLimitMaxCu: 4 } },
		}));

		let called = false;
		await pushConfig(config, {
			api,
			projectId,
			branchId: "br-main",
			allowProtectedBranch: true,
			updateExisting: true,
			confirm: () => {
				called = true;
				return true;
			},
		});

		expect(called).toBe(false);
		expect(api.history.some((h) => h.method === "updateEndpoint")).toBe(
			true,
		);
	});

	test("dryRun never invokes the confirm callback", async () => {
		const { api, projectId } = seededFake({ protected: true });
		const config = defineConfig(() => ({
			postgres: { computeSettings: { autoscalingLimitMaxCu: 4 } },
		}));

		let called = false;
		const result = await pushConfig(config, {
			api,
			projectId,
			branchId: "br-main",
			dryRun: true,
			confirm: () => {
				called = true;
				return true;
			},
		});

		expect(called).toBe(false);
		expect(result.dryRun).toBe(true);
	});

	test("dryRun surfaces selected branch plan without mutating", async () => {
		const { api, projectId } = seededFake();
		const config = defineConfig(() => ({
			protected: true,
			auth: {},
		}));

		const result = await pushConfig(config, {
			api,
			projectId,
			branchId: "br-main",
			dryRun: true,
			updateExisting: true,
		});

		expect(result.dryRun).toBe(true);
		expect(result.applied).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					kind: "branch",
					action: "update",
					identifier: "main",
				}),
				expect.objectContaining({
					kind: "service",
					identifier: "auth",
				}),
			]),
		);
		expect(api.history.some((h) => h.method === "updateBranch")).toBe(
			false,
		);
	});
});
