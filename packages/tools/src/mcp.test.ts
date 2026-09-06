import {
	Client as ClientV2,
	InMemoryTransport as InMemoryTransportV2,
} from "@modelcontextprotocol/client";
import { Client as ClientV1 } from "@modelcontextprotocol/sdk-v1/client/index.js";
import { InMemoryTransport as InMemoryTransportV1 } from "@modelcontextprotocol/sdk-v1/inMemory.js";
import { McpServer as McpServerV1 } from "@modelcontextprotocol/sdk-v1/server/mcp.js";
import { McpServer as McpServerV2 } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, test } from "vitest";
import { createNeonTools, publishedId, toolIds } from "./index.js";
import {
	type McpToolResult,
	registerNeonTools as registerNeonToolsV2,
} from "./mcp.js";
import { registerNeonTools as registerNeonToolsV1 } from "./mcp-v1.js";

const closeables: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
	await Promise.all(closeables.splice(0).map((value) => value.close()));
});

const tools = () =>
	createNeonTools({
		apiKey: "test-key",
		tools: ["projects.list"],
		fetch: async () =>
			new Response(
				JSON.stringify({
					projects: [{ id: "project-id" }],
					pagination: {},
				}),
				{ headers: { "content-type": "application/json" } },
			),
	});

describe("MCP v2 compatibility", () => {
	test("lists, validates, and calls registered Neon tools", async () => {
		const server = new McpServerV2({
			name: "test-server",
			version: "1.0.0",
		});
		registerNeonToolsV2(server, tools());
		const client = new ClientV2({ name: "test-client", version: "1.0.0" });
		const [clientTransport, serverTransport] =
			InMemoryTransportV2.createLinkedPair();
		await Promise.all([
			server.connect(serverTransport),
			client.connect(clientTransport),
		]);
		closeables.push(client, server);

		const listed = await client.listTools();
		expect(listed.tools.map((tool) => tool.name)).toEqual([
			"list_projects",
		]);
		expect(listed.tools[0].annotations?.readOnlyHint).toBe(true);
		expect(listed.tools[0]._meta?.["neon/requiresApproval"]).toBe(false);

		const called = await client.callTool({
			name: "list_projects",
			arguments: {},
		});
		expect(called.structuredContent).toEqual({
			data: [{ id: "project-id" }],
		});

		const invalid = await client.callTool({
			name: "list_projects",
			arguments: { limit: "one" },
		});
		expect(invalid.isError).toBe(true);
	});

	test("publishes an adapter name instead of tool.id", async () => {
		const server = new McpServerV2({
			name: "test-server",
			version: "1.0.0",
		});
		registerNeonToolsV2(server, tools(), {
			name: (tool) => `neon_${tool.id}`,
		});
		const client = new ClientV2({ name: "test-client", version: "1.0.0" });
		const [clientTransport, serverTransport] =
			InMemoryTransportV2.createLinkedPair();
		await Promise.all([
			server.connect(serverTransport),
			client.connect(clientTransport),
		]);
		closeables.push(client, server);

		const listed = await client.listTools();
		expect(listed.tools.map((tool) => tool.name)).toEqual([
			"neon_list_projects",
		]);
	});

	test("throws on duplicate adapter names before registerTool", () => {
		const server = new McpServerV2({
			name: "test-server",
			version: "1.0.0",
		});
		const catalog = createNeonTools({
			apiKey: "test-key",
			tools: ["projects.list", "projects.get"],
		});
		expect(() =>
			registerNeonToolsV2(server, catalog, { name: () => "same" }),
		).toThrow(/Duplicate Neon tool id "same"/);
	});

	test("publishes compact JSON Schema without OpenAPI field essays", async () => {
		const server = new McpServerV2({
			name: "test-server",
			version: "1.0.0",
		});
		registerNeonToolsV2(
			server,
			createNeonTools({
				apiKey: "test-key",
				tools: ["projects.update"],
			}),
		);
		const client = new ClientV2({ name: "test-client", version: "1.0.0" });
		const [clientTransport, serverTransport] =
			InMemoryTransportV2.createLinkedPair();
		await Promise.all([
			server.connect(serverTransport),
			client.connect(clientTransport),
		]);
		closeables.push(client, server);

		const listed = await client.listTools();
		const schema = listed.tools[0]?.inputSchema;
		expect(schema).toMatchObject({ type: "object" });
		expect(schema).not.toHaveProperty("$schema");
		expect(schema).not.toHaveProperty("description");
		expect(JSON.stringify(schema)).not.toContain("For more information");
	});

	test("publishes handwritten field descriptions on MCP 2", async () => {
		const server = new McpServerV2({
			name: "test-server",
			version: "1.0.0",
		});
		registerNeonToolsV2(
			server,
			createNeonTools({
				apiKey: "test-key",
				tools: ["postgres.connectionString"],
			}),
		);
		const client = new ClientV2({ name: "test-client", version: "1.0.0" });
		const [clientTransport, serverTransport] =
			InMemoryTransportV2.createLinkedPair();
		await Promise.all([
			server.connect(serverTransport),
			client.connect(clientTransport),
		]);
		closeables.push(client, server);

		const listed = await client.listTools();
		const pooled = listed.tools[0]?.inputSchema?.properties?.pooled;
		expect(pooled).toMatchObject({
			type: "boolean",
			description:
				"Return a pooled connection string. Default true. Set false for a direct connection.",
		});
	});

	test("returns API failures as structured MCP errors", async () => {
		type ToolHandler = (
			input: unknown,
			context: unknown,
		) => Promise<McpToolResult>;
		let handler: ToolHandler | undefined;
		const server = {
			registerTool(
				_name: string,
				_config: unknown,
				registeredHandler: ToolHandler,
			) {
				handler = registeredHandler;
			},
		};
		const failingTools = createNeonTools({
			apiKey: "bad-key",
			tools: ["projects.list"],
			fetch: async () =>
				new Response(
					JSON.stringify({ message: "Authentication failed" }),
					{
						status: 401,
						headers: { "content-type": "application/json" },
					},
				),
		});
		registerNeonToolsV2(server, failingTools);
		if (handler === undefined) {
			throw new Error("Expected MCP tool registration.");
		}

		const result = await handler({}, {});
		expect(result).toMatchObject({
			isError: true,
			structuredContent: {
				error: {
					message: expect.stringContaining("Authentication failed"),
				},
			},
		});
	});
});

const captureHandler = () => {
	type ToolHandler = (
		input: unknown,
		context: unknown,
	) => Promise<McpToolResult>;
	let handler: ToolHandler | undefined;
	const server = {
		registerTool(
			_name: string,
			_config: unknown,
			registeredHandler: ToolHandler,
		) {
			handler = registeredHandler;
		},
	};
	return {
		server,
		handler: () => {
			if (handler === undefined) {
				throw new Error("Expected MCP tool registration.");
			}
			return handler;
		},
	};
};

const toolsWithCapturedAuth = () => {
	const requests: Request[] = [];
	const tools = createNeonTools({
		apiKey: "constructor-key",
		tools: ["projects.list"],
		fetch: async (input, init) => {
			requests.push(new Request(input, init));
			return new Response(
				JSON.stringify({
					projects: [{ id: "project-id" }],
					pagination: {},
				}),
				{ headers: { "content-type": "application/json" } },
			);
		},
	});
	return { requests, tools };
};

describe("MCP request credentials", () => {
	test("sends MCP v2 http.authInfo.token as the Bearer credential", async () => {
		const { server, handler } = captureHandler();
		const { requests, tools } = toolsWithCapturedAuth();
		registerNeonToolsV2(server, tools);

		await handler()(
			{},
			{ http: { authInfo: { token: "oauth-access-token" } } },
		);

		expect(requests[0].headers.get("authorization")).toBe(
			"Bearer oauth-access-token",
		);
	});

	test("sends MCP v1 authInfo.token as the Bearer credential", async () => {
		const { server, handler } = captureHandler();
		const { requests, tools } = toolsWithCapturedAuth();
		registerNeonToolsV1(server, tools);

		await handler()({}, { authInfo: { token: "oauth-access-token" } });

		expect(requests[0].headers.get("authorization")).toBe(
			"Bearer oauth-access-token",
		);
	});

	test("uses the constructor credential when MCP extra has no authInfo", async () => {
		const { server, handler } = captureHandler();
		const { requests, tools } = toolsWithCapturedAuth();
		registerNeonToolsV2(server, tools);

		await handler()({}, {});

		expect(requests[0].headers.get("authorization")).toBe(
			"Bearer constructor-key",
		);
	});

	test("does not fall back to the constructor credential when authInfo is present without a token", async () => {
		const { server, handler } = captureHandler();
		const { requests, tools } = toolsWithCapturedAuth();
		registerNeonToolsV2(server, tools);

		const result = await handler()(
			{},
			{ http: { authInfo: { token: "" } } },
		);

		expect(result).toMatchObject({
			isError: true,
			structuredContent: {
				error: {
					message: expect.stringContaining(
						"A Neon API key or OAuth access token is required",
					),
				},
			},
		});
		expect(requests).toHaveLength(0);
	});
});

describe("MCP v1 compatibility", () => {
	test("registers and calls the same Zod 4 tool schema", async () => {
		const server = new McpServerV1({
			name: "test-server",
			version: "1.0.0",
		});
		registerNeonToolsV1(server, tools());
		const client = new ClientV1({ name: "test-client", version: "1.0.0" });
		const [clientTransport, serverTransport] =
			InMemoryTransportV1.createLinkedPair();
		await Promise.all([
			server.connect(serverTransport),
			client.connect(clientTransport),
		]);
		closeables.push(client, server);

		const called = await client.callTool({
			name: "list_projects",
			arguments: {},
		});
		expect(called.structuredContent).toEqual({
			data: [{ id: "project-id" }],
		});
	});
});

describe("MCP path injection", () => {
	test("lists and calls a project-scoped tool without a project_id argument", async () => {
		const requests: Request[] = [];
		const scoped = createNeonTools({
			apiKey: "test-key",
			tools: ["projects.get"],
			inject: {
				projectId: "granted-project",
				omitFromSchema: true,
			},
			fetch: async (input, init) => {
				requests.push(new Request(input, init));
				return new Response(
					JSON.stringify({ project: { id: "granted-project" } }),
					{ headers: { "content-type": "application/json" } },
				);
			},
		});
		const server = new McpServerV2({
			name: "test-server",
			version: "1.0.0",
		});
		registerNeonToolsV2(server, scoped);
		const client = new ClientV2({ name: "test-client", version: "1.0.0" });
		const [clientTransport, serverTransport] =
			InMemoryTransportV2.createLinkedPair();
		await Promise.all([
			server.connect(serverTransport),
			client.connect(clientTransport),
		]);
		closeables.push(client, server);

		const listed = await client.listTools();
		expect(listed.tools[0].inputSchema).toMatchObject({
			type: "object",
			properties: {},
		});

		const called = await client.callTool({
			name: "get_projects",
			arguments: {},
		});
		expect(called.structuredContent).toEqual({
			data: { id: "granted-project" },
		});
		expect(requests[0].url).toBe(
			"https://console.neon.tech/api/v2/projects/granted-project",
		);
	});

	test("lists an overridden description and a fill-mode optional project_id", async () => {
		const requests: Request[] = [];
		const scoped = createNeonTools({
			apiKey: "test-key",
			tools: ["projects.get"],
			descriptions: {
				"projects.get": "Get details of the granted Neon project.",
			},
			inject: { projectId: "granted-project" },
			fetch: async (input, init) => {
				requests.push(new Request(input, init));
				return new Response(
					JSON.stringify({ project: { id: "granted-project" } }),
					{ headers: { "content-type": "application/json" } },
				);
			},
		});
		const server = new McpServerV2({
			name: "test-server",
			version: "1.0.0",
		});
		registerNeonToolsV2(server, scoped);
		const client = new ClientV2({ name: "test-client", version: "1.0.0" });
		const [clientTransport, serverTransport] =
			InMemoryTransportV2.createLinkedPair();
		await Promise.all([
			server.connect(serverTransport),
			client.connect(clientTransport),
		]);
		closeables.push(client, server);

		const listed = await client.listTools();
		expect(listed.tools[0].description).toBe(
			"Get details of the granted Neon project.",
		);
		expect(listed.tools[0].inputSchema).toMatchObject({
			type: "object",
			properties: {
				project_id: { type: "string" },
			},
		});

		const called = await client.callTool({
			name: "get_projects",
			arguments: {},
		});
		expect(called.isError).toBeFalsy();
		expect(requests[0].url).toBe(
			"https://console.neon.tech/api/v2/projects/granted-project",
		);
	});

	test("registers omitted path schemas on MCP v1", async () => {
		const requests: Request[] = [];
		const scoped = createNeonTools({
			apiKey: "test-key",
			tools: ["projects.get"],
			inject: {
				projectId: "granted-project",
				omitFromSchema: true,
			},
			fetch: async (input, init) => {
				requests.push(new Request(input, init));
				return new Response(
					JSON.stringify({ project: { id: "granted-project" } }),
					{ headers: { "content-type": "application/json" } },
				);
			},
		});
		const server = new McpServerV1({
			name: "test-server",
			version: "1.0.0",
		});
		registerNeonToolsV1(server, scoped);
		const client = new ClientV1({ name: "test-client", version: "1.0.0" });
		const [clientTransport, serverTransport] =
			InMemoryTransportV1.createLinkedPair();
		await Promise.all([
			server.connect(serverTransport),
			client.connect(clientTransport),
		]);
		closeables.push(client, server);

		const called = await client.callTool({
			name: "get_projects",
			arguments: {},
		});
		expect(called.structuredContent).toEqual({
			data: { id: "granted-project" },
		});
		expect(requests[0].url).toBe(
			"https://console.neon.tech/api/v2/projects/granted-project",
		);
	});
});

describe("MCP catalog size", () => {
	test("listTools for every public tool stays under the compact bound", async () => {
		const server = new McpServerV2({
			name: "test-server",
			version: "1.0.0",
		});
		registerNeonToolsV2(
			server,
			createNeonTools({
				apiKey: "test-key",
				tools: toolIds,
			}),
		);
		const client = new ClientV2({ name: "test-client", version: "1.0.0" });
		const [clientTransport, serverTransport] =
			InMemoryTransportV2.createLinkedPair();
		await Promise.all([
			server.connect(serverTransport),
			client.connect(clientTransport),
		]);
		closeables.push(client, server);

		const listed: Array<{ name: string }> = [];
		let cursor: string | undefined;
		do {
			const page = await client.listTools(
				cursor === undefined ? {} : { cursor },
			);
			listed.push(...page.tools);
			cursor =
				page.nextCursor === undefined ? undefined : page.nextCursor;
		} while (cursor !== undefined && cursor.length > 0);

		expect(listed.map((tool) => tool.name).sort()).toEqual(
			[...toolIds].map(publishedId).sort(),
		);

		const chars = listed.reduce(
			(sum, tool) => sum + JSON.stringify(tool).length,
			0,
		);
		expect(chars / 4).toBeLessThan(20_000);
	});
});
