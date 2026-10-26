import { describe, expect, it, vi } from "vitest";
import { createNeonClient } from "./client.js";
import { NeonClientError } from "./errors.js";

const unchanged = new Set([
	"user.me",
	"user.organizations",
	"regions.list",
	"apiKeys.list",
	"projects.list",
	"projects.count",
	"projects.create",
	"projects.createAndConnect",
	"projects.transfer",
	"projects.transferFromUser",
	"postgres.connectionString",
]);

/** Exercise the public resource methods, including nested namespaces. */
function operations(client: object) {
	const found: Array<{
		name: string;
		invoke: (input: unknown, opts?: unknown) => unknown;
	}> = [];
	function visit(resource: object, prefix: string) {
		const proto = Object.getPrototypeOf(resource);
		if (proto && proto !== Object.prototype) {
			for (const key of Object.getOwnPropertyNames(proto)) {
				if (key === "constructor") continue;
				const name = `${prefix}.${key}`;
				const method = (resource as Record<string, unknown>)[key];
				if (
					typeof method === "function" &&
					!unchanged.has(name) &&
					!name.startsWith("consumption.")
				) {
					found.push({
						name,
						invoke: (input, opts) =>
							method.call(resource, input, opts),
					});
				}
			}
		}
		for (const [key, value] of Object.entries(resource)) {
			if (
				key !== "client" &&
				value !== null &&
				typeof value === "object"
			) {
				visit(value, prefix ? `${prefix}.${key}` : key);
			}
		}
	}
	visit(client, "");
	return found;
}

function consume(value: unknown): Promise<unknown> {
	if (
		value !== null &&
		typeof value === "object" &&
		"all" in value &&
		typeof value.all === "function"
	) {
		return value.all();
	}
	return Promise.resolve(value);
}

function requestAt(requests: Request[], index: number): Request {
	const request = requests[index];
	if (!request) throw new Error(`Missing request ${index}`);
	return request;
}

describe("named operation inputs", () => {
	const names = operations(createNeonClient({ apiKey: "unused" })).map(
		({ name }) => name,
	);
	for (const name of names) {
		it(`${name} rejects legacy and missing-selector inputs before fetching`, async () => {
			const fetch = vi.fn(async () => new Response("{}"));
			const client = createNeonClient({
				apiKey: "unused",
				fetch,
				retries: 0,
			});
			const operation = operations(client).find(
				(entry) => entry.name === name,
			);
			if (!operation) throw new Error(`Missing public operation ${name}`);
			for (const input of ["old-id", 42, null, undefined, [], {}]) {
				const result = await consume(operation.invoke(input));
				expect(result).toMatchObject({ error: { kind: "client" } });
				await expect(
					consume(operation.invoke(input, { throwOnError: true })),
				).rejects.toBeInstanceOf(NeonClientError);
			}
			expect(fetch).not.toHaveBeenCalled();
		});
	}

	it("invalid list inputs remain lazy and obey every consumption mode", async () => {
		const fetch = vi.fn(async () => new Response("{}"));
		const client = createNeonClient({ apiKey: "unused", fetch });
		// @ts-expect-error JavaScript caller using the removed positional signature
		const list = client.branches.list("old-project");
		expect(fetch).not.toHaveBeenCalled();
		await expect(list.page()).resolves.toMatchObject({
			error: { kind: "client" },
		});
		await expect(list.all()).resolves.toMatchObject({
			error: { kind: "client" },
		});
		await expect(
			list[Symbol.asyncIterator]().next(),
		).rejects.toBeInstanceOf(NeonClientError);
		expect(fetch).not.toHaveBeenCalled();
	});

	it("separates an encoded database locator from its new name and body", async () => {
		const requests: Request[] = [];
		const client = createNeonClient({
			apiKey: "unused",
			fetch: async (input, init) => {
				requests.push(
					input instanceof Request ? input : new Request(input, init),
				);
				return Response.json({ database: { name: "renamed" } });
			},
		});
		const result = await client.postgres.databases.update({
			projectId: "project one",
			branchId: "branch/two",
			databaseName: "old name",
			name: "renamed",
		});
		expect(result.error).toBeUndefined();
		expect(requests).toHaveLength(1);
		expect(requests[0]?.method).toBe("PATCH");
		expect(new URL(requestAt(requests, 0).url).pathname).toBe(
			"/api/v2/projects/project%20one/branches/branch%2Ftwo/databases/old%20name",
		);
		expect(await requestAt(requests, 0).json()).toEqual({
			database: { name: "renamed" },
		});
	});

	it("keeps named log selectors and filters stable across lazy pages", async () => {
		const requests: Request[] = [];
		const client = createNeonClient({
			apiKey: "unused",
			fetch: async (input, init) => {
				requests.push(
					input instanceof Request ? input : new Request(input, init),
				);
				return Response.json({
					logs: [{ message: `page ${requests.length}` }],
					is_truncated: requests.length === 1,
					next_cursor: requests.length === 1 ? "next" : "",
				});
			},
		});
		const params = { projectId: "p", branchId: "b", since: "1h", limit: 2 };
		const list = client.logs.query(params);
		params.projectId = "different";
		params.since = "2h";
		expect(requests).toHaveLength(0);
		const result = await list.all();
		expect(result.error).toBeUndefined();
		expect(requests).toHaveLength(2);
		for (const request of requests) {
			expect(new URL(request.url).pathname).toBe(
				"/api/v2/projects/p/branches/b/logs/query",
			);
		}
		expect(await requestAt(requests, 0).json()).toEqual({
			since: "1h",
			limit: 2,
		});
		expect(await requestAt(requests, 1).json()).toEqual({
			since: "1h",
			limit: 2,
			cursor: "next",
		});
	});

	it("routes confirmation flags from the operation input to the query only", async () => {
		const requests: Request[] = [];
		const client = createNeonClient({
			apiKey: "unused",
			fetch: async (input, init) => {
				requests.push(
					input instanceof Request ? input : new Request(input, init),
				);
				return Response.json({});
			},
		});
		await client.projects.members.setRole({
			projectId: "p",
			memberId: "m",
			role: "viewer",
			confirmSelfDemotion: true,
		});
		await client.projects.members.removeRole({
			projectId: "p",
			memberId: "m",
			confirmSelfLockout: true,
		});
		expect(
			new URL(requestAt(requests, 0).url).searchParams.get(
				"confirm_self_demotion",
			),
		).toBe("true");
		expect(await requestAt(requests, 0).json()).toEqual({ role: "viewer" });
		expect(
			new URL(requestAt(requests, 1).url).searchParams.get(
				"confirm_self_lockout",
			),
		).toBe("true");
		expect(await requestAt(requests, 1).text()).toBe("");
	});

	it("rejects relocated fields left on a shared options object before fetching", async () => {
		const fetch = vi.fn(async () => new Response("{}"));
		const client = createNeonClient({
			apiKey: "unused",
			fetch,
			retries: 0,
		});
		const options = { pooled: false, waitForReadiness: false };
		const project = await client.projects.createAndConnect(
			{ name: "app" },
			options,
		);
		expect(project).toMatchObject({
			error: {
				kind: "client",
				message: expect.stringContaining("pooled"),
			},
		});
		await expect(
			client.projects.createAndConnect(
				{ name: "app" },
				{ ...options, throwOnError: true },
			),
		).rejects.toBeInstanceOf(NeonClientError);
		const branch = await client.branches.createAndConnect(
			{ projectId: "p" },
			options,
		);
		expect(branch).toMatchObject({ error: { kind: "client" } });
		expect(fetch).not.toHaveBeenCalled();
	});

	it("rejects confirmation flags left in execution options before fetching", async () => {
		const fetch = vi.fn(async () => new Response("{}"));
		const client = createNeonClient({
			apiKey: "unused",
			fetch,
			retries: 0,
		});
		const demote = { confirmSelfDemotion: true, throwOnError: false };
		const setRole = await client.projects.members.setRole(
			{ projectId: "p", memberId: "m", role: "viewer" },
			demote,
		);
		expect(setRole).toMatchObject({
			error: {
				kind: "client",
				message: expect.stringContaining("confirmSelfDemotion"),
			},
		});
		const lockout = { confirmSelfLockout: true, waitForReadiness: false };
		const removeRole = await client.projects.members.removeRole(
			{ projectId: "p", memberId: "m" },
			lockout,
		);
		expect(removeRole).toMatchObject({ error: { kind: "client" } });
		expect(fetch).not.toHaveBeenCalled();
	});

	it("rejects relocated options on lazy lists and waitFor before fetching", async () => {
		const fetch = vi.fn(async () => new Response("{}"));
		const client = createNeonClient({
			apiKey: "unused",
			fetch,
			retries: 0,
		});
		const options = { pooled: false, throwOnError: false };
		const list = client.functions.list(
			{ projectId: "p", branchId: "b" },
			options,
		);
		expect(fetch).not.toHaveBeenCalled();
		await expect(list.all()).resolves.toMatchObject({
			error: { kind: "client" },
		});
		await expect(
			client.operations.waitFor({ operations: [] }, options),
		).resolves.toMatchObject({ error: { kind: "client" } });
		await expect(
			client.postgres.connectionString({ projectId: "p" }, options),
		).resolves.toMatchObject({ error: { kind: "client" } });
		expect(fetch).not.toHaveBeenCalled();
	});

	it("keeps pooled on the input and honours client and per-call execution options", async () => {
		const requests: Request[] = [];
		const fetch = vi.fn(
			async (input: RequestInfo | URL, init?: RequestInit) => {
				requests.push(
					input instanceof Request ? input : new Request(input, init),
				);
				return Response.json({
					project: { id: "p-1" },
					connection_uris: [
						{
							connection_uri: "postgresql://u:pw@ep-host/db",
							connection_parameters: {
								host: "ep-host",
								pooler_host: "ep-pooler",
							},
						},
					],
					operations: [],
				});
			},
		);
		const client = createNeonClient({
			apiKey: "unused",
			fetch,
			retries: 0,
			throwOnError: true,
			waitForReadiness: true,
			orgId: "org-1",
			requestTimeoutMs: 30_000,
		});
		const data = await client.projects.createAndConnect(
			{ name: "app", pooled: false },
			{ waitForReadiness: false, throwOnError: true },
		);
		expect(data.connectionString).toBe("postgresql://u:pw@ep-host/db");
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(await requestAt(requests, 0).json()).toEqual({
			project: { name: "app", org_id: "org-1" },
		});
		const envelope = await client.projects.createAndConnect(
			{ name: "app", pooled: true },
			{ waitForReadiness: false, throwOnError: false },
		);
		expect(envelope).toMatchObject({
			data: {
				connectionString: "postgresql://u:pw@ep-pooler/db",
			},
		});
		expect(fetch).toHaveBeenCalledTimes(2);
	});
});
