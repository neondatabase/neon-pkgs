import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig, ErrorCode } from "@neondatabase/config";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { FakeNeonApi } from "./fake-neon-api.js";
import { pushConfig } from "./push-config.js";

// A real on-disk function source so `buildFunctionBundle` (real esbuild) has something to
// bundle. We avoid mocks per the project's no-mocks rule: the deploy path runs esbuild for
// real against this trivial handler.
let fnSource: string;
let fnTmpDir: string;
beforeAll(() => {
	fnTmpDir = mkdtempSync(join(tmpdir(), "neon-fn-"));
	fnSource = join(fnTmpDir, "hello-world.ts");
	writeFileSync(
		fnSource,
		"export default { fetch(_req: Request): Response { return new Response('ok'); } };\n",
	);
});
afterAll(() => {
	rmSync(fnTmpDir, { recursive: true, force: true });
});

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
		const config = defineConfig({
			auth: {},
			dataApi: {},
			branch: (branch) => ({
				postgres: {
					computeSettings: {
						autoscalingLimitMaxCu: branch.name === "main" ? 4 : 1,
					},
				},
			}),
		});

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
		const config = defineConfig({
			branch: () => ({
				postgres: { computeSettings: { autoscalingLimitMaxCu: 4 } },
			}),
		});

		await expect(
			pushConfig(config, { api, projectId, branchId: "br-main" }),
		).rejects.toMatchObject({
			code: ErrorCode.PushConflict,
		});
	});

	test("confirm callback applies mutable drift when user accepts", async () => {
		const { api, projectId } = seededFake();
		const config = defineConfig({
			branch: () => ({
				postgres: { computeSettings: { autoscalingLimitMaxCu: 4 } },
			}),
		});

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
		const config = defineConfig({
			branch: () => ({
				postgres: { computeSettings: { autoscalingLimitMaxCu: 4 } },
			}),
		});

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
		const config = defineConfig({ auth: {} });

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
		const config = defineConfig({
			branch: () => ({
				postgres: { computeSettings: { autoscalingLimitMaxCu: 4 } },
			}),
		});

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
		const config = defineConfig({
			branch: () => ({
				postgres: { computeSettings: { autoscalingLimitMaxCu: 4 } },
			}),
		});

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
		const config = defineConfig({
			branch: () => ({
				postgres: { computeSettings: { autoscalingLimitMaxCu: 4 } },
			}),
		});

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

	test("creates buckets, creates + deploys functions, and enables AI Gateway", async () => {
		const { api, projectId } = seededFake();
		const config = defineConfig({
			preview: {
				functions: {
					fn1: {
						name: "Hello World",
						source: fnSource,
						env: { RESEND_API_KEY: "re_abc" },
					},
				},
				buckets: { uploads: {} },
				aiGateway: {},
			},
		});

		const result = await pushConfig(config, {
			api,
			projectId,
			branchId: "br-main",
		});

		expect(result.applied).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					kind: "service",
					action: "create",
					identifier: "bucket:uploads",
				}),
				expect.objectContaining({
					kind: "service",
					action: "create",
					identifier: "function:fn1",
				}),
				expect.objectContaining({
					kind: "service",
					action: "create",
					identifier: "aiGateway",
				}),
			]),
		);
		// The function exists and now has an active deployment on the branch.
		const functions = await api.listBranchFunctions(projectId, "br-main");
		expect(functions).toEqual([
			expect.objectContaining({
				slug: "fn1",
				activeDeploymentId: 1,
			}),
		]);
		expect(await api.getAiGatewayEnabled(projectId, "br-main")).toBe(true);
		expect(
			(await api.listBranchBuckets(projectId, "br-main")).map(
				(b) => b.name,
			),
		).toEqual(["uploads"]);
	});

	test("only probes the Preview features the policy declares", async () => {
		const { api, projectId } = seededFake();
		// Policy declares functions only — no buckets, no aiGateway.
		const config = defineConfig({
			preview: {
				functions: { fn1: { name: "Hello World", source: fnSource } },
			},
		});

		await pushConfig(config, { api, projectId, branchId: "br-main" });

		const methods = api.history.map((h) => h.method);
		expect(methods).toContain("listBranchFunctions");
		// AI Gateway / buckets are not in the policy, so they are never read — this is
		// what keeps `plan`/`apply` from failing on a Preview feature the user didn't ask
		// for when it's unavailable in the project/region.
		expect(methods).not.toContain("getAiGatewayEnabled");
		expect(methods).not.toContain("listBranchBuckets");
	});

	test("uses an injected bundleFunction instead of the default esbuild bundler", async () => {
		const { api, projectId } = seededFake();
		const config = defineConfig({
			preview: {
				functions: { fn1: { name: "Hello World", source: fnSource } },
			},
		});

		const bundled: string[] = [];
		const sentinel = new Uint8Array([1, 2, 3, 4]);
		await pushConfig(config, {
			api,
			projectId,
			branchId: "br-main",
			// A bundler that never touches esbuild — proves the seam is honored.
			bundleFunction: async (fn) => {
				bundled.push(fn.slug);
				return sentinel;
			},
		});

		expect(bundled).toEqual(["fn1"]);
		const deploys = api.history.filter(
			(h) => h.method === "deployBranchFunction",
		);
		expect(deploys).toHaveLength(1);
		const input = (deploys[0].args[3] as { bundle: Uint8Array }).bundle;
		expect(Array.from(input)).toEqual([1, 2, 3, 4]);
	});

	test("re-deploys an existing function as an update, without duplicating it", async () => {
		const { api, projectId } = seededFake();
		api.seedFunction(projectId, "br-main", {
			id: "fn-existing",
			slug: "fn1",
			name: "Hello World",
			invocationUrl: "https://x/functions/fn1",
		});
		const config = defineConfig({
			preview: {
				functions: { fn1: { name: "Hello World", source: fnSource } },
			},
		});

		const result = await pushConfig(config, {
			api,
			projectId,
			branchId: "br-main",
		});

		// A single deploy ships the new code; the function is not recreated.
		expect(
			api.history.filter((h) => h.method === "deployBranchFunction"),
		).toHaveLength(1);
		expect(result.applied).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					kind: "service",
					action: "update",
					identifier: "function:fn1",
				}),
			]),
		);
		// Still exactly one function on the branch (no duplicate created).
		const functions = await api.listBranchFunctions(projectId, "br-main");
		expect(functions.map((f) => f.slug)).toEqual(["fn1"]);
	});

	test("dryRun plans preview steps without mutating", async () => {
		const { api, projectId } = seededFake();
		const config = defineConfig({
			preview: { buckets: { uploads: {} }, aiGateway: {} },
		});

		const result = await pushConfig(config, {
			api,
			projectId,
			branchId: "br-main",
			dryRun: true,
		});

		expect(result.applied).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ identifier: "bucket:uploads" }),
				expect.objectContaining({ identifier: "aiGateway" }),
			]),
		);
		expect(api.history.some((h) => h.method === "createBranchBucket")).toBe(
			false,
		);
		expect(api.history.some((h) => h.method === "enableAiGateway")).toBe(
			false,
		);
	});

	test("dryRun surfaces selected branch plan without mutating", async () => {
		const { api, projectId } = seededFake();
		const config = defineConfig({
			auth: {},
			branch: () => ({ protected: true }),
		});

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
