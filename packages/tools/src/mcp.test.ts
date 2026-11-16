import {
	Client as ClientV2,
	InMemoryTransport as InMemoryTransportV2,
} from "@modelcontextprotocol/client";
import { Client as ClientV1 } from "@modelcontextprotocol/sdk-v1/client/index.js";
import { InMemoryTransport as InMemoryTransportV1 } from "@modelcontextprotocol/sdk-v1/inMemory.js";
import { McpServer as McpServerV1 } from "@modelcontextprotocol/sdk-v1/server/mcp.js";
import { McpServer as McpServerV2 } from "@modelcontextprotocol/server";
import { NeonWaitTimeoutError } from "@neon/sdk";
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

const projectListItem = (id: string) => ({
	id,
	platform_id: "aws",
	region_id: "aws-us-east-2",
	name: id,
	provisioner: "k8s-neonvm",
	pg_version: 17,
	proxy_host: "us-east-2.aws.neon.tech",
	branch_logical_size_limit: 0,
	branch_logical_size_limit_bytes: 0,
	store_passwords: true,
	active_time: 0,
	cpu_used_sec: 0,
	creation_source: "console",
	created_at: "2026-01-01T00:00:00Z",
	updated_at: "2026-01-01T00:00:00Z",
	owner_id: "owner-id",
});

const project = (id: string) => {
	const { active_time: _activeTime, ...item } = projectListItem(id);
	return {
		...item,
		data_storage_bytes_hour: 0,
		data_transfer_bytes: 0,
		written_data_bytes: 0,
		compute_time_seconds: 0,
		active_time_seconds: 0,
		history_retention_seconds: 86_400,
		consumption_period_start: "2026-01-01T00:00:00Z",
		consumption_period_end: "2026-02-01T00:00:00Z",
	};
};

const tools = () =>
	createNeonTools({
		apiKey: "test-key",
		tools: ["projects.list"],
		fetch: async () =>
			new Response(
				JSON.stringify({
					projects: [projectListItem("project-id")],
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
			data: [projectListItem("project-id")],
		});

		const invalid = await client.callTool({
			name: "list_projects",
			arguments: { limit: "one" },
		});
		expect(invalid.isError).toBe(true);
	});

	test("publishes the result shape and rejects a result that breaks it", async () => {
		const server = new McpServerV2({
			name: "test-server",
			version: "1.0.0",
		});
		const { id: _id, ...withoutId } = projectListItem("project-id");
		registerNeonToolsV2(
			server,
			createNeonTools({
				apiKey: "test-key",
				tools: ["projects.list"],
				fetch: async () =>
					new Response(
						JSON.stringify({
							projects: [withoutId],
							pagination: {},
						}),
						{ headers: { "content-type": "application/json" } },
					),
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
		const outputSchema = listed.tools[0]?.outputSchema;
		expect(outputSchema).toMatchObject({
			properties: {
				data: {
					type: "array",
					items: {
						type: "object",
						required: expect.arrayContaining(["id"]),
					},
				},
			},
		});
		expect(JSON.stringify(outputSchema)).not.toContain("description");

		const called = await client.callTool({
			name: "list_projects",
			arguments: {},
		});
		expect(called.isError).toBe(true);
		expect(JSON.stringify(called.content)).toContain(
			"Output validation error",
		);
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
				"Pooled connection string; default true, false for a direct one.",
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
						headers: {
							"content-type": "application/json",
							"x-request-id": "req-auth-1",
						},
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
					name: "NeonAuthError",
					kind: "auth",
					status: 401,
					requestId: "req-auth-1",
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
					projects: [projectListItem("project-id")],
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
					name: "TypeError",
					message: expect.stringContaining(
						"A Neon API key or OAuth access token is required",
					),
				},
			},
		});
		expect(result.structuredContent.error).not.toHaveProperty("kind");
		expect(requests).toHaveLength(0);
	});

	test("copies name, kind, status, and code from a thrown non-NeonError", async () => {
		const { server, handler } = captureHandler();
		const catalog = createNeonTools({
			apiKey: "test-key",
			tools: ["projects.list"] as const,
			fetch: async () =>
				new Response(JSON.stringify({ projects: [], pagination: {} }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
		});
		const thrown = Object.assign(new Error("branch limit"), {
			name: "ConflictError",
			kind: "conflict",
			status: 409,
			code: "branch_limit",
			source: "wait",
			timeoutMs: 30_000,
			requestId: "req-1",
			reason: "ECONNRESET",
			operationId: "op-1",
		});
		registerNeonToolsV2(server, {
			"projects.list": {
				...catalog["projects.list"],
				execute: async () => {
					throw thrown;
				},
			},
		});

		const result = await handler()({}, {});
		const structuredContent = {
			error: {
				message: "branch limit",
				name: "ConflictError",
				kind: "conflict",
				status: 409,
				code: "branch_limit",
				source: "wait",
				timeoutMs: 30_000,
				requestId: "req-1",
				reason: "ECONNRESET",
				operationId: "op-1",
			},
		};
		expect(result).toEqual({
			isError: true,
			content: [
				{
					type: "text",
					text: JSON.stringify(structuredContent),
				},
			],
			structuredContent,
		});
	});

	test("copies wait-timeout source without the operations list", async () => {
		const { server, handler } = captureHandler();
		const catalog = createNeonTools({
			apiKey: "test-key",
			tools: ["projects.list"] as const,
			fetch: async () =>
				new Response(JSON.stringify({ projects: [], pagination: {} }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
		});
		registerNeonToolsV2(server, {
			"projects.list": {
				...catalog["projects.list"],
				execute: async () => {
					throw new NeonWaitTimeoutError("Timed out waiting.", {
						timeoutMs: 5_000,
						operations: [
							{
								id: "op-1",
								project_id: "project-id",
								action: "create_branch",
								status: "running",
								failures_count: 0,
								created_at: "2026-01-01T00:00:00Z",
								updated_at: "2026-01-01T00:00:00Z",
								total_duration_ms: 0,
							},
						],
					});
				},
			},
		});

		const result = await handler()({}, {});
		expect(result.isError).toBe(true);
		expect(result.structuredContent).toEqual({
			error: {
				message: "Timed out waiting.",
				name: "NeonWaitTimeoutError",
				kind: "timeout",
				source: "wait",
				timeoutMs: 5_000,
			},
		});
		expect(result.structuredContent.error).not.toHaveProperty("operations");
	});

	test("omits non-finite timeoutMs and status from MCP errors", async () => {
		const { server, handler } = captureHandler();
		const catalog = createNeonTools({
			apiKey: "test-key",
			tools: ["projects.list"] as const,
			fetch: async () =>
				new Response(JSON.stringify({ projects: [], pagination: {} }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
		});
		registerNeonToolsV2(server, {
			"projects.list": {
				...catalog["projects.list"],
				execute: async () => {
					throw Object.assign(new Error("Timed out"), {
						name: "TimeoutError",
						kind: "timeout",
						timeoutMs: Number.NaN,
						status: Number.POSITIVE_INFINITY,
					});
				},
			},
		});

		const result = await handler()({}, {});
		const structuredContent = {
			error: {
				message: "Timed out",
				name: "TimeoutError",
				kind: "timeout",
			},
		};
		expect(result).toEqual({
			isError: true,
			content: [
				{
					type: "text",
					text: JSON.stringify(structuredContent),
				},
			],
			structuredContent,
		});
		expect(result.structuredContent.error).not.toHaveProperty("timeoutMs");
		expect(result.structuredContent.error).not.toHaveProperty("status");
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

		const listed = await client.listTools();
		expect(listed.tools[0]?.outputSchema).toMatchObject({
			type: "object",
			properties: { data: { type: "array" } },
			required: ["data"],
		});
		const called = await client.callTool({
			name: "list_projects",
			arguments: {},
		});
		expect(called.structuredContent).toEqual({
			data: [projectListItem("project-id")],
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
					JSON.stringify({ project: project("granted-project") }),
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
			data: project("granted-project"),
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
					JSON.stringify({ project: project("granted-project") }),
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
					JSON.stringify({ project: project("granted-project") }),
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
			data: project("granted-project"),
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

		const listed: Array<{ name: string; outputSchema?: unknown }> = [];
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

		const tokens = (values: unknown[]) =>
			values.reduce<number>(
				(sum, value) => sum + JSON.stringify(value).length,
				0,
			) / 4;
		// About 43,700 tokens with a description on every input, including the custom tools.
		expect(
			tokens(listed.map(({ outputSchema: _output, ...tool }) => tool)),
		).toBeLessThan(43_800);
		// About 21,800 tokens: every tool's top-level result fields, typed.
		expect(tokens(listed.map((tool) => tool.outputSchema))).toBeLessThan(
			22_000,
		);
		expect(
			listed.filter((tool) => tool.outputSchema === undefined),
		).toEqual([]);
	});
});
