import { describe, expect, it } from "vitest";
import { createNeonClient } from "../client.js";
import type { NeonConfig } from "../config.js";
import {
	NeonApiError,
	NeonClientError,
	NeonOperationError,
} from "../errors.js";

function neonRouting(
	respond: (request: { url: string; method: string; body: unknown }) => {
		status: number;
		body: unknown;
	},
	config: Omit<Partial<NeonConfig>, "throwOnError" | "apiKey" | "fetch"> = {},
) {
	const calls: Array<{ url: string; method: string; body: unknown }> = [];
	const neon = createNeonClient({
		apiKey: "test",
		retries: 0,
		...config,
		fetch: async (input, init) => {
			const request = input instanceof Request ? input : undefined;
			const url = request ? request.url : String(input);
			const method = (
				request?.method ??
				init?.method ??
				"GET"
			).toUpperCase();
			const raw = request ? await request.clone().text() : init?.body;
			const call = {
				url,
				method,
				body:
					typeof raw === "string" && raw.length > 0
						? JSON.parse(raw)
						: raw,
			};
			calls.push(call);
			const { status, body } = respond(call);
			return new Response(JSON.stringify(body), {
				status,
				headers: { "content-type": "application/json" },
			});
		},
	});
	return { neon, calls };
}

describe("branches.create", () => {
	it("posts a read-write endpoint by default and unwraps the branch", async () => {
		const { neon, calls } = neonRouting(() => ({
			status: 201,
			body: {
				branch: { id: "br-1", name: "feature" },
				endpoints: [{ id: "ep-1", type: "read_write" }],
			},
		}));

		const { data, error } = await neon.branches.create({
			projectId: "p-1",
			name: "feature",
			parent_id: "br-parent",
			compute: { minCu: 0.5, maxCu: 2, suspendTimeoutSeconds: 300 },
		});

		expect(error).toBeUndefined();
		expect(data).toEqual({ id: "br-1", name: "feature" });
		expect(calls).toHaveLength(1);
		expect(calls[0]?.body).toEqual({
			branch: { name: "feature", parent_id: "br-parent" },
			endpoints: [
				{
					type: "read_write",
					autoscaling_limit_min_cu: 0.5,
					autoscaling_limit_max_cu: 2,
					suspend_timeout_seconds: 300,
				},
			],
		});
	});

	it("posts a read-write endpoint when compute is omitted", async () => {
		const { neon, calls } = neonRouting(() => ({
			status: 201,
			body: { branch: { id: "br-1", name: "feature" } },
		}));

		await neon.branches.create({ projectId: "p-1", name: "feature" });

		expect(calls[0]?.body).toEqual({
			branch: { name: "feature" },
			endpoints: [{ type: "read_write" }],
		});
	});

	it("omits endpoints when noCompute is true", async () => {
		const { neon, calls } = neonRouting(() => ({
			status: 201,
			body: { branch: { id: "br-1", name: "bare" } },
		}));

		const { data, error } = await neon.branches.create({
			projectId: "p-1",
			name: "bare",
			noCompute: true,
		});

		expect(error).toBeUndefined();
		expect(data).toEqual({ id: "br-1", name: "bare" });
		expect(calls[0]?.body).toEqual({ branch: { name: "bare" } });
	});

	it("rejects noCompute together with compute settings without fetching", async () => {
		const { neon, calls } = neonRouting(() => ({
			status: 500,
			body: { message: "should not be called" },
		}));

		// @ts-expect-error runtime guard for JS callers
		const { data, error } = await neon.branches.create({
			projectId: "p-1",
			noCompute: true,
			compute: { minCu: 1 },
		});

		expect(data).toBeUndefined();
		expect(error).toBeInstanceOf(NeonClientError);
		expect(error?.kind).toBe("client");
		expect(error?.message).toBe(
			"Pass compute settings or noCompute, not both.",
		);
		expect(calls).toHaveLength(0);

		const throwing = createNeonClient({
			apiKey: "test",
			retries: 0,
			throwOnError: true,
			fetch: async () => {
				throw new Error("should not be called");
			},
		});
		await expect(
			// @ts-expect-error runtime guard for JS callers
			throwing.branches.create({
				projectId: "p-1",
				noCompute: true,
				compute: { minCu: 1 },
			}),
		).rejects.toMatchObject({
			kind: "client",
			message: "Pass compute settings or noCompute, not both.",
		});
	});
});

describe("creating a branch from a parent with an expiration date", () => {
	const API_MESSAGE =
		"Branches with an expiration date cannot have child branches";
	const refused = (code: string, message: string) => ({
		status: 400,
		body: { request_id: "req-1", code, message },
	});

	it("names the parent and both ways forward, keeping the API error", async () => {
		const { neon, calls } = neonRouting(() =>
			refused("BRANCHING_IS_NOT_ALLOWED", API_MESSAGE),
		);

		const { error } = await neon.branches.create({
			projectId: "p-1",
			name: "scratch",
			parent_id: "br-expiring",
		});

		expect(error).toBeInstanceOf(NeonApiError);
		expect(error).toMatchObject({
			kind: "api",
			status: 400,
			code: "BRANCHING_IS_NOT_ALLOWED",
			requestId: "req-1",
			body: { code: "BRANCHING_IS_NOT_ALLOWED", message: API_MESSAGE },
		});
		expect(error?.message).toBe(
			`Cannot branch from br-expiring because it has an expiration date. Create the branch from a parent without one, or remove the expiration from br-expiring (update it with expires_at: null) and retry. Removing it keeps br-expiring until someone deletes it, so get the user's agreement first. (API error: "${API_MESSAGE}")`,
		);
		expect(calls).toHaveLength(1);

		await expect(
			neon.branches.create(
				{ projectId: "p-1", parent_id: "br-expiring" },
				{ throwOnError: true },
			),
		).rejects.toMatchObject({
			code: "BRANCHING_IS_NOT_ALLOWED",
			message: expect.stringMatching(/^Cannot branch from br-expiring /),
		});
	});

	it("explains the same refusal from createAndConnect", async () => {
		const { neon } = neonRouting(() =>
			refused("BRANCHING_IS_NOT_ALLOWED", API_MESSAGE),
		);

		const { error } = await neon.branches.createAndConnect({
			projectId: "p-1",
			parentId: "br-expiring",
		});

		expect(error?.message).toMatch(
			/^Cannot branch from br-expiring because it has an expiration date\./,
		);
	});

	it("keeps the API message for another BRANCHING_IS_NOT_ALLOWED rule", async () => {
		const message = "Branching is not allowed for this branch";
		const { neon } = neonRouting(() =>
			refused("BRANCHING_IS_NOT_ALLOWED", message),
		);

		const { error } = await neon.branches.create({
			projectId: "p-1",
			parent_id: "br-expiring",
		});

		expect(error?.message).toBe(message);
	});
});

describe("branches.createAndConnect", () => {
	it("posts a read-write endpoint and returns a pooled connection string", async () => {
		const { neon, calls } = neonRouting(() => ({
			status: 201,
			body: {
				branch: { id: "br-1", name: "feature" },
				endpoints: [{ id: "ep-1", type: "read_write" }],
				connection_uris: [
					{
						connection_uri: "postgresql://user:pass@ep-host/neondb",
						connection_parameters: {
							host: "ep-host",
							pooler_host: "ep-pooler-host",
						},
					},
				],
			},
		}));

		const { data, error } = await neon.branches.createAndConnect({
			projectId: "p-1",
			name: "feature",
			parentId: "br-parent",
		});

		expect(error).toBeUndefined();
		expect(data).toEqual({
			branch: { id: "br-1", name: "feature" },
			endpoint: { id: "ep-1", type: "read_write" },
			connectionString: "postgresql://user:pass@ep-pooler-host/neondb",
		});
		expect(calls[0]?.body).toEqual({
			branch: { name: "feature", parent_id: "br-parent" },
			endpoints: [{ type: "read_write" }],
		});
	});
});

describe("branches.delete", () => {
	const BRANCH_URL = "/projects/p-1/branches/br-1";
	const operation = (status: string, action = "delete_timeline") => ({
		id: "op-1",
		project_id: "p-1",
		branch_id: "br-1",
		action,
		status,
		failures_count: 0,
		created_at: "2026-01-01T00:00:00Z",
		updated_at: "2026-01-01T00:00:00Z",
		total_duration_ms: 0,
	});
	const waiting = { wait: { pollIntervalMs: 1, timeoutMs: 5_000 } };

	function deleteRouting(
		options: {
			deleted?: string;
			polled?: string;
			readBack?: { status: number; body: unknown };
		},
		config: Omit<
			Partial<NeonConfig>,
			"throwOnError" | "apiKey" | "fetch"
		> = waiting,
	) {
		return neonRouting(({ url, method }) => {
			if (method === "DELETE") {
				return {
					status: 200,
					body: {
						branch: { id: "br-1" },
						operations: [operation(options.deleted ?? "running")],
					},
				};
			}
			if (url.includes("/operations/")) {
				return {
					status: 200,
					body: {
						operation: operation(options.polled ?? "finished"),
					},
				};
			}
			return (
				options.readBack ?? {
					status: 404,
					body: { code: "", message: "branch not found" },
				}
			);
		}, config);
	}

	const readBacks = (calls: Array<{ url: string; method: string }>) =>
		calls.filter(
			(call) => call.method === "GET" && call.url.endsWith(BRANCH_URL),
		);

	it("resolves when a cleanup operation fails after the branch is gone", async () => {
		const { neon, calls } = deleteRouting({ polled: "failed" });

		const result = await neon.branches.delete(
			{ projectId: "p-1", branchId: "br-1" },
			{ waitForReadiness: true },
		);

		expect(result).toEqual({ data: { id: "br-1" }, error: undefined });
		expect(readBacks(calls)).toHaveLength(1);
	});

	it("resolves on a throwing call when the client waits on every mutation", async () => {
		const { neon } = deleteRouting(
			{ polled: "failed" },
			{ ...waiting, waitForReadiness: true },
		);

		await expect(
			neon.branches.delete(
				{ projectId: "p-1", branchId: "br-1" },
				{ throwOnError: true },
			),
		).resolves.toEqual({ id: "br-1" });
	});

	it("throws the operation error on a throwing call while the branch is still readable", async () => {
		const { neon } = deleteRouting(
			{
				polled: "failed",
				readBack: { status: 200, body: { branch: { id: "br-1" } } },
			},
			{ ...waiting, waitForReadiness: true },
		);

		await expect(
			neon.branches.delete(
				{ projectId: "p-1", branchId: "br-1" },
				{ throwOnError: true },
			),
		).rejects.toBeInstanceOf(NeonOperationError);
	});

	it("resolves when the delete response already reports a failed operation", async () => {
		const { neon, calls } = deleteRouting({ deleted: "failed" });

		const result = await neon.branches.delete(
			{ projectId: "p-1", branchId: "br-1" },
			{ waitForReadiness: true },
		);

		expect(result).toEqual({ data: { id: "br-1" }, error: undefined });
		expect(calls.some((call) => call.url.includes("/operations/"))).toBe(
			false,
		);
		expect(readBacks(calls)).toHaveLength(1);
	});

	it("keeps the operation error while the branch is still readable", async () => {
		const { neon } = deleteRouting({
			polled: "failed",
			readBack: { status: 200, body: { branch: { id: "br-1" } } },
		});

		const { error } = await neon.branches.delete(
			{ projectId: "p-1", branchId: "br-1" },
			{ waitForReadiness: true },
		);

		expect(error).toBeInstanceOf(NeonOperationError);
		expect(error).toMatchObject({ operationId: "op-1", status: "failed" });
	});

	it.each([
		403, 500,
	])("keeps the operation error when the read-back answers %i", async (status) => {
		const { neon } = deleteRouting({
			polled: "error",
			readBack: { status, body: { message: "unavailable" } },
		});

		const { error } = await neon.branches.delete(
			{ projectId: "p-1", branchId: "br-1" },
			{ waitForReadiness: true },
		);

		expect(error).toBeInstanceOf(NeonOperationError);
		expect(error).toMatchObject({ status: "error" });
	});

	it("does not read the branch back after a wait timeout", async () => {
		const { neon, calls } = deleteRouting(
			{ polled: "running" },
			{ wait: { pollIntervalMs: 1, timeoutMs: 20 } },
		);

		const { error } = await neon.branches.delete(
			{ projectId: "p-1", branchId: "br-1" },
			{ waitForReadiness: true },
		);

		expect(error?.kind).toBe("timeout");
		expect(readBacks(calls)).toHaveLength(0);
	});

	it("reports an abort while reading the branch back", async () => {
		const controller = new AbortController();
		const { neon } = neonRouting(({ url, method }) => {
			if (method === "DELETE") {
				return {
					status: 200,
					body: {
						branch: { id: "br-1" },
						operations: [operation("failed")],
					},
				};
			}
			controller.abort();
			return { status: 404, body: { message: `no ${url}` } };
		}, waiting);

		const { error } = await neon.branches.delete(
			{ projectId: "p-1", branchId: "br-1" },
			{ waitForReadiness: true, signal: controller.signal },
		);

		expect(error?.kind).toBe("aborted");
	});

	it("does not read the branch back when its operations finish", async () => {
		const { neon, calls } = deleteRouting({});

		const result = await neon.branches.delete(
			{ projectId: "p-1", branchId: "br-1" },
			{ waitForReadiness: true },
		);

		expect(result).toEqual({ data: { id: "br-1" }, error: undefined });
		expect(readBacks(calls)).toHaveLength(0);
	});

	it.each([
		["no", {}],
		["a JSON", { "content-type": "application/json" }],
	])("resolves to null when Neon answers 204 with %s content type", async (_, headers) => {
		const neon = createNeonClient({
			apiKey: "test",
			retries: 0,
			...waiting,
			fetch: async () => new Response(null, { status: 204, headers }),
		});

		const result = await neon.branches.delete(
			{ projectId: "p-1", branchId: "br-1" },
			{ waitForReadiness: true },
		);

		expect(result).toEqual({ data: null, error: undefined });
	});

	it("neither polls nor reads back without readiness polling", async () => {
		const { neon, calls } = deleteRouting({ deleted: "failed" });

		const result = await neon.branches.delete({
			projectId: "p-1",
			branchId: "br-1",
		});

		expect(result).toEqual({ data: { id: "br-1" }, error: undefined });
		expect(calls).toHaveLength(1);
	});
});

describe("branches.resetFromParent", () => {
	it("restores from the parent HEAD and unwraps the branch", async () => {
		const { neon, calls } = neonRouting(({ url }) => {
			if (url.includes("/restore")) {
				return {
					status: 200,
					body: {
						branch: { id: "br-child", name: "feature" },
						operations: [],
					},
				};
			}
			return {
				status: 200,
				body: { branch: { id: "br-child", parent_id: "br-parent" } },
			};
		});

		const { data, error } = await neon.branches.resetFromParent({
			projectId: "p-1",
			branchId: "br-child",
			preserveUnderName: "feature-old",
		});

		expect(error).toBeUndefined();
		expect(data).toEqual({ id: "br-child", name: "feature" });
		expect(calls).toHaveLength(2);
		expect(calls[1]?.url).toContain(
			"/projects/p-1/branches/br-child/restore",
		);
		expect(calls[1]?.body).toEqual({
			source_branch_id: "br-parent",
			preserve_under_name: "feature-old",
		});
	});

	it("does not restore when the branch has no parent", async () => {
		const { neon, calls } = neonRouting(() => ({
			status: 200,
			body: { branch: { id: "br-root" } },
		}));

		const { data, error } = await neon.branches.resetFromParent({
			projectId: "p-1",
			branchId: "br-root",
		});

		expect(data).toBeUndefined();
		expect(error?.kind).toBe("client");
		expect(error?.message).toBe(
			"Branch has no parent and cannot be reset.",
		);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.url).not.toContain("/restore");
	});
});

describe("branches.compareSchema", () => {
	it("sends databaseName as db_name and returns the diff", async () => {
		const { neon, calls } = neonRouting(() => ({
			status: 200,
			body: { diff: "--- a\n+++ b\n" },
		}));

		const { data, error } = await neon.branches.compareSchema({
			projectId: "p-1",
			branchId: "br-child",
			databaseName: "neondb",
			baseBranchId: "br-parent",
			lsn: "0/1",
			baseLsn: "0/2",
		});

		expect(error).toBeUndefined();
		expect(data).toEqual({ diff: "--- a\n+++ b\n" });
		const url = new URL(calls[0]?.url ?? "http://invalid");
		expect(url.pathname).toBe(
			"/api/v2/projects/p-1/branches/br-child/compare_schema",
		);
		expect(url.searchParams.get("db_name")).toBe("neondb");
		expect(url.searchParams.get("base_branch_id")).toBe("br-parent");
		expect(url.searchParams.get("lsn")).toBe("0/1");
		expect(url.searchParams.get("base_lsn")).toBe("0/2");
		expect(url.searchParams.has("timestamp")).toBe(false);
	});
});
