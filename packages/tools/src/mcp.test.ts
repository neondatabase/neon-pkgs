import {
	Client as ClientV2,
	InMemoryTransport as InMemoryTransportV2,
} from "@modelcontextprotocol/client";
import { Client as ClientV1 } from "@modelcontextprotocol/sdk-v1/client/index.js";
import { InMemoryTransport as InMemoryTransportV1 } from "@modelcontextprotocol/sdk-v1/inMemory.js";
import { McpServer as McpServerV1 } from "@modelcontextprotocol/sdk-v1/server/mcp.js";
import { McpServer as McpServerV2 } from "@modelcontextprotocol/server";
import { afterEach, describe, expect, test } from "vitest";
import { createNeonTools } from "./index.js";
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
		operations: ["listProjects"],
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
			data: { projects: [{ id: "project-id" }], pagination: {} },
		});

		const invalid = await client.callTool({
			name: "list_projects",
			arguments: { query: { limit: "one" } },
		});
		expect(invalid.isError).toBe(true);
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
			operations: ["listProjects"],
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
		operations: ["listProjects"],
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
			data: { projects: [{ id: "project-id" }], pagination: {} },
		});
	});
});

describe("MCP path injection", () => {
	test("lists and calls a project-scoped tool without a project_id argument", async () => {
		const requests: Request[] = [];
		const scoped = createNeonTools({
			apiKey: "test-key",
			operations: ["getProject"],
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
			name: "get_project",
			arguments: {},
		});
		expect(called.structuredContent).toEqual({
			data: { project: { id: "granted-project" } },
		});
		expect(requests[0].url).toBe(
			"https://console.neon.tech/api/v2/projects/granted-project",
		);
	});

	test("lists an overridden description and a fill-mode optional project_id", async () => {
		const requests: Request[] = [];
		const scoped = createNeonTools({
			apiKey: "test-key",
			operations: ["getProject"],
			descriptions: {
				getProject: "Get details of the granted Neon project.",
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
				path: {
					type: "object",
					properties: { project_id: { type: "string" } },
				},
			},
		});

		const called = await client.callTool({
			name: "get_project",
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
			operations: ["getProject"],
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
			name: "get_project",
			arguments: {},
		});
		expect(called.structuredContent).toEqual({
			data: { project: { id: "granted-project" } },
		});
		expect(requests[0].url).toBe(
			"https://console.neon.tech/api/v2/projects/granted-project",
		);
	});
});
