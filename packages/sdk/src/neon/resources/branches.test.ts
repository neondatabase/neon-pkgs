import { describe, expect, it } from "vitest";
import { createNeonClient } from "../client.js";

function neonRouting(
	respond: (request: { url: string; method: string; body: unknown }) => {
		status: number;
		body: unknown;
	},
) {
	const calls: Array<{ url: string; method: string; body: unknown }> = [];
	const neon = createNeonClient({
		apiKey: "test",
		retries: 0,
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
	it("posts a read-write endpoint by default and keeps the endpoint on the result", async () => {
		const { neon, calls } = neonRouting(() => ({
			status: 201,
			body: {
				branch: { id: "br-1", name: "feature" },
				endpoints: [{ id: "ep-1", type: "read_write" }],
			},
		}));

		const { data, error } = await neon.branches.create("p-1", {
			name: "feature",
			parent_id: "br-parent",
			compute: { minCu: 0.5, maxCu: 2, suspendTimeoutSeconds: 300 },
		});

		expect(error).toBeUndefined();
		expect(data).toEqual({
			branch: { id: "br-1", name: "feature" },
			endpoints: [{ id: "ep-1", type: "read_write" }],
			endpoint: { id: "ep-1", type: "read_write" },
			connectionUris: undefined,
			connectionString: undefined,
		});
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

		await neon.branches.create("p-1", { name: "feature" });

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

		const { data, error } = await neon.branches.create("p-1", {
			name: "bare",
			noCompute: true,
		});

		expect(error).toBeUndefined();
		expect(data).toEqual({
			branch: { id: "br-1", name: "bare" },
			endpoint: undefined,
			endpoints: undefined,
			connectionUris: undefined,
			connectionString: undefined,
		});
		expect(calls[0]?.body).toEqual({ branch: { name: "bare" } });
	});

	it("rejects noCompute together with compute settings without fetching", async () => {
		const { neon, calls } = neonRouting(() => ({
			status: 500,
			body: { message: "should not be called" },
		}));

		const { data, error } = await neon.branches.create("p-1", {
			noCompute: true,
			// @ts-expect-error runtime guard for JS callers
			compute: { minCu: 1 },
		});

		expect(data).toBeUndefined();
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
			throwing.branches.create("p-1", {
				noCompute: true,
				// @ts-expect-error runtime guard for JS callers
				compute: { minCu: 1 },
			}),
		).rejects.toMatchObject({
			kind: "client",
			message: "Pass compute settings or noCompute, not both.",
		});
	});

	it("keeps a pooled connection string when the API returns one", async () => {
		const { neon } = neonRouting(() => ({
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

		const { data, error } = await neon.branches.create("p-1", {
			name: "feature",
		});

		expect(error).toBeUndefined();
		expect(data).toEqual({
			branch: { id: "br-1", name: "feature" },
			endpoints: [{ id: "ep-1", type: "read_write" }],
			endpoint: { id: "ep-1", type: "read_write" },
			connectionUris: [
				{
					connection_uri: "postgresql://user:pass@ep-host/neondb",
					connection_parameters: {
						host: "ep-host",
						pooler_host: "ep-pooler-host",
					},
				},
			],
			connectionString: "postgresql://user:pass@ep-pooler-host/neondb",
		});
	});

	it("keeps every endpoint and URI the API returned", async () => {
		const { neon } = neonRouting(() => ({
			status: 201,
			body: {
				branch: { id: "br-1", name: "feature" },
				endpoints: [
					{ id: "ep-rw", type: "read_write" },
					{ id: "ep-ro", type: "read_only" },
				],
				connection_uris: [
					{
						connection_uri: "postgresql://a@ep-a/neondb",
						connection_parameters: {
							host: "ep-a",
							pooler_host: "ep-a-pooler",
						},
					},
					{
						connection_uri: "postgresql://b@ep-b/neondb",
						connection_parameters: {
							host: "ep-b",
							pooler_host: "ep-b-pooler",
						},
					},
				],
			},
		}));

		const { data, error } = await neon.branches.create("p-1", {
			name: "feature",
		});

		expect(error).toBeUndefined();
		expect(data?.endpoints?.map((endpoint) => endpoint.id)).toEqual([
			"ep-rw",
			"ep-ro",
		]);
		expect(data?.endpoint?.id).toBe("ep-rw");
		expect(data?.connectionUris).toHaveLength(2);
		expect(data?.connectionString).toBe(
			"postgresql://a@ep-a-pooler/neondb",
		);
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

		const { data, error } = await neon.branches.createAndConnect("p-1", {
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

	it("errors when the create response has no connection URI", async () => {
		const { neon } = neonRouting(() => ({
			status: 201,
			body: {
				branch: { id: "br-1", name: "feature" },
				endpoints: [{ id: "ep-1", type: "read_write" }],
			},
		}));

		const { data, error } = await neon.branches.createAndConnect("p-1", {
			name: "feature",
		});

		expect(data).toBeUndefined();
		expect(error?.kind).toBe("client");
		expect(error?.message).toMatch(/did not include a connection URI/);
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

		const { data, error } = await neon.branches.resetFromParent(
			"p-1",
			"br-child",
			{ preserveUnderName: "feature-old" },
		);

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

		const { data, error } = await neon.branches.resetFromParent(
			"p-1",
			"br-root",
		);

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

		const { data, error } = await neon.branches.compareSchema(
			"p-1",
			"br-child",
			{
				databaseName: "neondb",
				baseBranchId: "br-parent",
				lsn: "0/1",
				baseLsn: "0/2",
			},
		);

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
