import { describe, expect, it } from "vitest";
import { createNeonClient, type NeonClient } from "./client.js";
import type { NeonConfig } from "./config.js";
import type { CallOptions } from "./context.js";
import type { NeonResult } from "./result.js";

function operation(status: "running" | "finished", action: string) {
	return {
		id: "op-1",
		project_id: "p-1",
		action,
		status,
		failures_count: 0,
		created_at: "2026-01-01T00:00:00Z",
		updated_at: "2026-01-01T00:00:00Z",
		total_duration_ms: 0,
	};
}

const connectionUris = [
	{
		connection_uri: "postgresql://user:pass@ep-host/neondb",
		connection_parameters: {
			host: "ep-host",
			pooler_host: "ep-pooler-host",
		},
	},
];

function neonRouting(
	respond: (request: { url: string; method: string }) => {
		status: number;
		body: unknown;
	},
	config: Omit<Partial<NeonConfig>, "throwOnError" | "apiKey" | "fetch"> = {},
): {
	neon: NeonClient<false>;
	calls: Array<{ url: string; method: string }>;
} {
	const calls: Array<{ url: string; method: string }> = [];
	const neon = createNeonClient({
		apiKey: "test",
		retries: 0,
		wait: { pollIntervalMs: 1, timeoutMs: 5_000 },
		...config,
		fetch: async (input, init) => {
			const request = input instanceof Request ? input : undefined;
			const url = request ? request.url : String(input);
			const method = (
				request?.method ??
				init?.method ??
				"GET"
			).toUpperCase();
			const call = { url, method };
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

function polled(calls: Array<{ url: string; method: string }>) {
	return calls.some(
		(call) => call.method === "GET" && call.url.includes("/operations/"),
	);
}

function createRespond(
	kind: "project" | "projectConnect" | "branch" | "branchConnect",
) {
	const action =
		kind === "project" || kind === "projectConnect"
			? "create_timeline"
			: "create_branch";
	return ({ url, method }: { url: string; method: string }) => {
		if (method === "GET" && url.includes("/operations/")) {
			return {
				status: 200,
				body: { operation: operation("finished", action) },
			};
		}
		const operations = [operation("running", action)];
		if (kind === "project") {
			return {
				status: 201,
				body: { project: { id: "p-1", name: "app" }, operations },
			};
		}
		if (kind === "projectConnect") {
			return {
				status: 201,
				body: {
					project: { id: "p-1", name: "app" },
					operations,
					connection_uris: connectionUris,
				},
			};
		}
		if (kind === "branch") {
			return {
				status: 201,
				body: {
					branch: { id: "br-1", name: "feature" },
					endpoints: [{ id: "ep-1", type: "read_write" }],
					operations,
				},
			};
		}
		return {
			status: 201,
			body: {
				branch: { id: "br-1", name: "feature" },
				endpoints: [{ id: "ep-1", type: "read_write" }],
				operations,
				connection_uris: connectionUris,
			},
		};
	};
}

const methods = [
	{
		name: "projects.create",
		kind: "project" as const,
		call: (
			neon: NeonClient<false>,
			opts?: CallOptions<false>,
		): Promise<NeonResult<unknown>> =>
			opts
				? neon.projects.create({ name: "app" }, opts)
				: neon.projects.create({ name: "app" }),
	},
	{
		name: "projects.createAndConnect",
		kind: "projectConnect" as const,
		call: (
			neon: NeonClient<false>,
			opts?: CallOptions<false>,
		): Promise<NeonResult<unknown>> =>
			opts
				? neon.projects.createAndConnect({ name: "app" }, opts)
				: neon.projects.createAndConnect({ name: "app" }),
	},
	{
		name: "branches.create",
		kind: "branch" as const,
		call: (
			neon: NeonClient<false>,
			opts?: CallOptions<false>,
		): Promise<NeonResult<unknown>> =>
			opts
				? neon.branches.create("p-1", { name: "feature" }, opts)
				: neon.branches.create("p-1", { name: "feature" }),
	},
	{
		name: "branches.createAndConnect",
		kind: "branchConnect" as const,
		call: (
			neon: NeonClient<false>,
			opts?: CallOptions<false>,
		): Promise<NeonResult<unknown>> =>
			opts
				? neon.branches.createAndConnect(
						"p-1",
						{ name: "feature" },
						opts,
					)
				: neon.branches.createAndConnect("p-1", { name: "feature" }),
	},
];

describe("create-family waitForReadiness precedence", () => {
	for (const method of methods) {
		describe(method.name, () => {
			it("does not poll when the client sets waitForReadiness: false", async () => {
				const { neon, calls } = neonRouting(
					createRespond(method.kind),
					{
						waitForReadiness: false,
					},
				);
				const { error } = await method.call(neon);
				expect(error).toBeUndefined();
				expect(polled(calls)).toBe(false);
			});

			it("polls when the client option is unset (method default)", async () => {
				const { neon, calls } = neonRouting(createRespond(method.kind));
				const { error } = await method.call(neon);
				expect(error).toBeUndefined();
				expect(polled(calls)).toBe(true);
			});

			it("polls when the client is false and the call passes true", async () => {
				const { neon, calls } = neonRouting(
					createRespond(method.kind),
					{
						waitForReadiness: false,
					},
				);
				const { error } = await method.call(neon, {
					waitForReadiness: true,
				});
				expect(error).toBeUndefined();
				expect(polled(calls)).toBe(true);
			});

			it("does not poll when the client is true and the call passes false", async () => {
				const { neon, calls } = neonRouting(
					createRespond(method.kind),
					{
						waitForReadiness: true,
					},
				);
				const { error } = await method.call(neon, {
					waitForReadiness: false,
				});
				expect(error).toBeUndefined();
				expect(polled(calls)).toBe(false);
			});

			it("does not poll when the client is unset and the call passes false", async () => {
				const { neon, calls } = neonRouting(createRespond(method.kind));
				const { error } = await method.call(neon, {
					waitForReadiness: false,
				});
				expect(error).toBeUndefined();
				expect(polled(calls)).toBe(false);
			});
		});
	}

	it("does not poll projects.update when the client option is unset", async () => {
		const { neon, calls } = neonRouting(({ url, method }) => {
			if (method === "GET" && url.includes("/operations/")) {
				return {
					status: 200,
					body: { operation: operation("finished", "apply_config") },
				};
			}
			return {
				status: 200,
				body: {
					project: { id: "p-1", name: "renamed" },
					operations: [operation("running", "apply_config")],
				},
			};
		});
		const { error } = await neon.projects.update("p-1", {
			name: "renamed",
		});
		expect(error).toBeUndefined();
		expect(polled(calls)).toBe(false);
	});

	it("polls projects.update when the client sets waitForReadiness: true", async () => {
		const { neon, calls } = neonRouting(
			({ url, method }) => {
				if (method === "GET" && url.includes("/operations/")) {
					return {
						status: 200,
						body: {
							operation: operation("finished", "apply_config"),
						},
					};
				}
				return {
					status: 200,
					body: {
						project: { id: "p-1", name: "renamed" },
						operations: [operation("running", "apply_config")],
					},
				};
			},
			{ waitForReadiness: true },
		);
		const { error } = await neon.projects.update("p-1", {
			name: "renamed",
		});
		expect(error).toBeUndefined();
		expect(polled(calls)).toBe(true);
	});
});
