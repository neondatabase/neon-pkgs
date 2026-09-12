import { describe, expect, it, vi } from "vitest";
import { createNeonClient } from "./client.js";
import { NeonClientError } from "./errors.js";

const unchanged = new Set([
	"user.me",
	"user.organizations",
	"regions.list",
	"apiKeys.list",
	"projects.list",
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
});
