import { describe, expect, test } from "vitest";
import {
	createNeonTool,
	createNeonTools,
	type NeonToolsClientOptions,
} from "./index.js";

const jsonResponse = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});

describe("createNeonTools", () => {
	test("creates only the explicitly selected tools", () => {
		const tools = createNeonTools({
			apiKey: "test-key",
			tools: ["projects.list", "projects.createAndConnect"] as const,
		});

		expect(Object.keys(tools)).toEqual([
			"projects.list",
			"projects.createAndConnect",
		]);
		expect(tools["projects.list"].id).toBe("list_projects");
		expect(tools["projects.createAndConnect"].id).toBe(
			"create_and_connect_projects",
		);
	});

	test("lists every page and returns the unwrapped items", async () => {
		const requests: Request[] = [];
		const tools = createNeonTools({
			apiKey: "test-key",
			tools: ["projects.list"] as const,
			fetch: async (input, init) => {
				const request =
					input instanceof Request ? input : new Request(input, init);
				requests.push(request);
				const url = new URL(request.url);
				if (url.searchParams.get("cursor") === "page-2") {
					return jsonResponse({
						projects: [{ id: "project-2" }],
						pagination: {},
					});
				}
				return jsonResponse({
					projects: [{ id: "project-1" }],
					pagination: { cursor: "page-2" },
				});
			},
		});

		const uncapped = await tools["projects.list"].execute({
			search: "demo",
		});
		expect(uncapped).toEqual({
			data: [{ id: "project-1" }, { id: "project-2" }],
		});
		expect(requests).toHaveLength(2);
		expect(requests[0].url).toContain("search=demo");
		expect(requests[0].url).not.toContain("cursor=");
		expect(requests[1].url).toContain("cursor=page-2");

		requests.length = 0;
		const capped = await tools["projects.list"].execute({
			limit: 1,
			search: "demo",
		});
		expect(capped).toEqual({
			data: [{ id: "project-1" }],
		});
		expect(requests).toHaveLength(1);
		expect(requests[0].url).toContain("limit=1");
		expect(requests[0].headers.get("authorization")).toBe(
			"Bearer test-key",
		);
		expect(
			tools["projects.list"].inputSchema.safeParse({
				limit: "one",
			}).success,
		).toBe(false);
		expect(
			tools["projects.list"].inputSchema.safeParse({
				cursor: "page-2",
			}).success,
		).toBe(false);
	});

	test("maps a write through the ergonomic client and waits on operations", async () => {
		const requests: Request[] = [];
		const tools = createNeonTools({
			apiKey: "test-key",
			tools: ["projects.update"] as const,
			wait: { pollIntervalMs: 1, timeoutMs: 5_000 },
			fetch: async (input, init) => {
				const request =
					input instanceof Request ? input : new Request(input, init);
				requests.push(request);
				const url = new URL(request.url);
				if (url.pathname.endsWith("/operations/op-1")) {
					return jsonResponse({
						operation: {
							id: "op-1",
							project_id: "project-id",
							action: "update_project",
							status: "finished",
						},
					});
				}
				return jsonResponse({
					project: { id: "project-id", name: "renamed" },
					operations: [
						{
							id: "op-1",
							project_id: "project-id",
							action: "update_project",
							status: "running",
						},
					],
				});
			},
		});

		const result = await tools["projects.update"].execute({
			project_id: "project-id",
			name: "renamed",
		});

		expect(result).toEqual({
			data: { id: "project-id", name: "renamed" },
		});
		expect(requests).toHaveLength(2);
		expect(requests[0].method).toBe("PATCH");
		expect(requests[1].method).toBe("GET");
		expect(requests[1].url).toContain(
			"/projects/project-id/operations/op-1",
		);
		expect(await requests[0].json()).toEqual({
			project: { name: "renamed" },
		});
		expect(tools["projects.update"].requiresApproval).toBe(true);
		expect(tools["projects.update"].annotations.readOnlyHint).toBe(false);
	});

	test("does not poll functions.deploy because the response has no operations", async () => {
		const requests: Request[] = [];
		const tools = createNeonTools({
			apiKey: "test-key",
			tools: ["functions.deploy"] as const,
			fetch: async (input, init) => {
				requests.push(new Request(input, init));
				return jsonResponse({
					deployment: { id: "deployment-id", status: "pending" },
				});
			},
		});

		const result = await tools["functions.deploy"].execute({
			project_id: "project-id",
			branch_id: "branch-id",
			slug: "demo",
		});

		expect(result).toEqual({
			data: { id: "deployment-id", status: "pending" },
		});
		expect(requests).toHaveLength(1);
	});

	test("rejects a call with no tools", () => {
		expect(() =>
			Reflect.apply(createNeonTools, undefined, [{ apiKey: "test-key" }]),
		).toThrow("createNeonTools requires at least one tool");
		expect(() =>
			Reflect.apply(createNeonTools, undefined, [
				{ apiKey: "test-key", tools: [] },
			]),
		).toThrow("createNeonTools requires at least one tool");
	});

	test("rejects duplicate selections", () => {
		expect(() =>
			createNeonTools({
				apiKey: "test-key",
				tools: ["projects.list", "projects.list"],
			}),
		).toThrow('Duplicate Neon tool "projects.list"');
	});

	test("reports unknown runtime tool ids", () => {
		expect(() =>
			Reflect.apply(createNeonTools, undefined, [
				{ apiKey: "test-key", tools: ["projects.lis"] },
			]),
		).toThrow('Unknown Neon tool "projects.lis"');
		expect(() =>
			Reflect.apply(createNeonTool, undefined, [
				"projects.lis",
				{ apiKey: "test-key" },
			]),
		).toThrow('Unknown Neon tool "projects.lis"');
	});
});

describe("Bearer credentials", () => {
	const listProjects = (options: NeonToolsClientOptions) => {
		const requests: Request[] = [];
		const tools = createNeonTools({
			...options,
			tools: ["projects.list"] as const,
			fetch: async (input, init) => {
				requests.push(new Request(input, init));
				return jsonResponse({ projects: [], pagination: {} });
			},
		});
		return { requests, tools };
	};

	test("sends an OAuth access token as a Bearer credential", async () => {
		const { requests, tools } = listProjects({
			apiKey: "oauth-access-token",
		});

		await tools["projects.list"].execute({});

		expect(requests[0].headers.get("authorization")).toBe(
			"Bearer oauth-access-token",
		);
	});

	test("resolves a credential getter on every execute", async () => {
		let issued = 0;
		const { requests, tools } = listProjects({
			apiKey: () => {
				issued += 1;
				return `oauth-access-token-${issued}`;
			},
		});

		await tools["projects.list"].execute({});
		await tools["projects.list"].execute({});

		expect(issued).toBeGreaterThanOrEqual(2);
		expect(requests).toHaveLength(2);
		expect(requests[1].headers.get("authorization")).not.toBe(
			requests[0].headers.get("authorization"),
		);
	});

	test("uses an execute-time credential instead of the constructor credential", async () => {
		const { requests, tools } = listProjects({
			apiKey: "constructor-key",
		});

		await tools["projects.list"].execute(
			{},
			{ apiKey: "oauth-access-token" },
		);

		expect(requests[0].headers.get("authorization")).toBe(
			"Bearer oauth-access-token",
		);
	});

	test("keeps concurrent execute-time credentials isolated", async () => {
		const { requests, tools } = listProjects({
			apiKey: "constructor-key",
		});

		await Promise.all([
			tools["projects.list"].execute({}, { apiKey: "oauth-token-a" }),
			tools["projects.list"].execute({}, { apiKey: "oauth-token-b" }),
		]);

		expect(
			[
				...requests.map((request) =>
					request.headers.get("authorization"),
				),
			].sort(),
		).toEqual(["Bearer oauth-token-a", "Bearer oauth-token-b"]);
	});

	test("requires a credential at execute when none was given at construction", async () => {
		const { requests, tools } = listProjects({});

		await expect(tools["projects.list"].execute({})).rejects.toThrow(
			"A Neon API key or OAuth access token is required",
		);
		expect(requests).toHaveLength(0);
	});

	test("does not fall back to the constructor credential when execute overrides it with an empty value", async () => {
		const { requests, tools } = listProjects({
			apiKey: "constructor-key",
		});

		await expect(
			tools["projects.list"].execute({}, { apiKey: "" }),
		).rejects.toThrow("A Neon API key or OAuth access token is required");
		expect(requests).toHaveLength(0);
	});

	test("does not fall back to the constructor credential when an execute-time getter resolves empty", async () => {
		const { requests, tools } = listProjects({
			apiKey: "constructor-key",
		});

		await expect(
			tools["projects.list"].execute({}, { apiKey: () => "" }),
		).rejects.toThrow("A Neon API key or OAuth access token is required");
		expect(requests).toHaveLength(0);
	});
});
