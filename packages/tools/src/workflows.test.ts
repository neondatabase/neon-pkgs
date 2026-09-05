import { describe, expect, test } from "vitest";
import * as z from "zod";
import {
	createNeonTool,
	createNeonTools,
	type NeonToolsClientOptions,
} from "./index.js";

const jsonResponse = (body: unknown, status = 201) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});

const branchWithComputeBody = {
	branch: { id: "br-id", name: "feature-x" },
	endpoints: [{ id: "ep-id", type: "read_write" }],
	connection_uris: [
		{
			connection_uri: "postgresql://user:pass@ep-host/neondb",
			connection_parameters: {
				host: "ep-host",
				pooler_host: "ep-pooler-host",
			},
		},
	],
};

const projectWithUriBody = {
	project: { id: "project-id", name: "tool-created" },
	connection_uris: [
		{
			connection_uri: "postgresql://user:pass@ep-host/neondb",
			connection_parameters: {
				host: "ep-host",
				pooler_host: "ep-pooler-host",
			},
		},
	],
};

const createBranchOnlyTools = (options: NeonToolsClientOptions = {}) => {
	const requests: Request[] = [];
	const tools = createNeonTools({
		apiKey: "test-key",
		...options,
		tools: ["branches.create"] as const,
		fetch: async (input, init) => {
			requests.push(new Request(input, init));
			return jsonResponse(branchWithComputeBody);
		},
	});
	return { requests, tools };
};

const createBranchTools = (options: NeonToolsClientOptions = {}) => {
	const requests: Request[] = [];
	const tools = createNeonTools({
		apiKey: "test-key",
		...options,
		tools: ["branches.createAndConnect"] as const,
		fetch: async (input, init) => {
			requests.push(new Request(input, init));
			return jsonResponse(branchWithComputeBody);
		},
	});
	return { requests, tools };
};

describe("branches.create", () => {
	test("posts a read-write endpoint and returns the branch, endpoint, and pooled URI", async () => {
		const { requests, tools } = createBranchOnlyTools();

		const result = await tools["branches.create"].execute({
			project_id: "project-id",
			name: "feature-x",
			parent_id: "br-parent",
			compute: {
				min_cu: 0.5,
				max_cu: 2,
				suspend_timeout_seconds: 300,
			},
		});

		expect(requests).toHaveLength(1);
		expect(await requests[0].json()).toEqual({
			branch: { name: "feature-x", parent_id: "br-parent" },
			endpoints: [
				{
					type: "read_write",
					autoscaling_limit_min_cu: 0.5,
					autoscaling_limit_max_cu: 2,
					suspend_timeout_seconds: 300,
				},
			],
		});
		expect(result).toEqual({
			data: {
				branch: { id: "br-id", name: "feature-x" },
				endpoints: [{ id: "ep-id", type: "read_write" }],
				endpoint: { id: "ep-id", type: "read_write" },
				connectionUris: [
					{
						connection_uri: "postgresql://user:pass@ep-host/neondb",
						connection_parameters: {
							host: "ep-host",
							pooler_host: "ep-pooler-host",
						},
					},
				],
				connectionString:
					"postgresql://user:pass@ep-pooler-host/neondb",
			},
		});
	});

	test("omits endpoints when no_compute is true", async () => {
		const { requests, tools } = createBranchOnlyTools();

		await tools["branches.create"].execute({
			project_id: "project-id",
			name: "bare",
			no_compute: true,
		});

		expect(await requests[0].json()).toEqual({
			branch: { name: "bare" },
		});
	});

	test("rejects no_compute together with compute", () => {
		const { tools } = createBranchOnlyTools();

		expect(
			tools["branches.create"].inputSchema.safeParse({
				project_id: "project-id",
				no_compute: true,
				compute: { min_cu: 1 },
			}).success,
		).toBe(false);
	});

	test("does not publish pooled", () => {
		const { tools } = createBranchOnlyTools();
		const schema = z.toJSONSchema(tools["branches.create"].inputSchema);

		expect(schema.properties).not.toHaveProperty("pooled");
		expect(schema.properties).toHaveProperty("no_compute");
		expect(schema.properties).toHaveProperty("compute");
	});
});

describe("projects.create", () => {
	test("posts the project body and returns the project without a connection string", async () => {
		const requests: Request[] = [];
		const tools = createNeonTools({
			apiKey: "test-key",
			tools: ["projects.create"] as const,
			fetch: async (input, init) => {
				requests.push(new Request(input, init));
				return jsonResponse(projectWithUriBody);
			},
		});

		const result = await tools["projects.create"].execute({
			name: "tool-created",
			region_id: "aws-us-east-1",
		});

		expect(await requests[0].json()).toEqual({
			project: {
				name: "tool-created",
				region_id: "aws-us-east-1",
			},
		});
		expect(result).toEqual({
			data: { id: "project-id", name: "tool-created" },
		});
		expect(result.data).not.toHaveProperty("connectionString");
	});

	test("does not publish pooled or no_compute", () => {
		const tools = createNeonTools({
			apiKey: "test-key",
			tools: ["projects.create"] as const,
		});
		const schema = z.toJSONSchema(tools["projects.create"].inputSchema);

		expect(schema.properties).not.toHaveProperty("pooled");
		expect(schema.properties).not.toHaveProperty("no_compute");
	});
});

describe("branches.createAndConnect", () => {
	test("creates only the selected tool", () => {
		const tools = createNeonTools({
			apiKey: "test-key",
			tools: ["branches.createAndConnect"] as const,
		});

		expect(Object.keys(tools)).toEqual(["branches.createAndConnect"]);
		expect(tools["branches.createAndConnect"].id).toBe(
			"create_and_connect_branches",
		);
		expect(tools["branches.createAndConnect"].operationId).toBe(
			"branches.createAndConnect",
		);
		expect(tools["branches.createAndConnect"].requiresApproval).toBe(true);
		expect(tools["branches.createAndConnect"].annotations).toEqual({
			readOnlyHint: false,
			destructiveHint: true,
			openWorldHint: false,
		});
	});

	test("posts a read-write endpoint and returns the SDK workflow result", async () => {
		const { requests, tools } = createBranchTools();

		const result = await tools["branches.createAndConnect"].execute({
			project_id: "project-id",
			name: "feature-x",
			parent_id: "br-parent",
			compute: {
				min_cu: 0.5,
				max_cu: 2,
				suspend_timeout_seconds: 300,
			},
		});

		expect(requests).toHaveLength(1);
		expect(requests[0].method).toBe("POST");
		expect(requests[0].url).toBe(
			"https://console.neon.tech/api/v2/projects/project-id/branches",
		);
		expect(await requests[0].json()).toEqual({
			branch: { name: "feature-x", parent_id: "br-parent" },
			endpoints: [
				{
					type: "read_write",
					autoscaling_limit_min_cu: 0.5,
					autoscaling_limit_max_cu: 2,
					suspend_timeout_seconds: 300,
				},
			],
		});
		expect(result).toEqual({
			data: {
				branch: { id: "br-id", name: "feature-x" },
				endpoint: { id: "ep-id", type: "read_write" },
				connectionString:
					"postgresql://user:pass@ep-pooler-host/neondb",
			},
		});
	});

	test("forwards pooled: false to the SDK connection-string picker", async () => {
		const { tools } = createBranchTools();

		const result = await tools["branches.createAndConnect"].execute({
			project_id: "project-id",
			pooled: false,
		});

		expect(result.data.connectionString).toBe(
			"postgresql://user:pass@ep-host/neondb",
		);
	});

	test("forwards an abort signal to the SDK call", async () => {
		const controller = new AbortController();
		controller.abort();
		const { tools } = createBranchTools();

		await expect(
			tools["branches.createAndConnect"].execute(
				{ project_id: "project-id" },
				{ signal: controller.signal },
			),
		).rejects.toThrow();
	});

	test("describes pooled on the published schema", () => {
		const { tools } = createBranchTools();
		const schema = z.toJSONSchema(
			tools["branches.createAndConnect"].inputSchema,
		);
		const pooled = schema.properties?.pooled;

		expect(pooled).toMatchObject({
			type: "boolean",
			description: expect.stringContaining("Default true"),
		});
	});

	test("rejects unknown input fields", () => {
		const { tools } = createBranchTools();

		expect(
			tools["branches.createAndConnect"].inputSchema.safeParse({
				project_id: "project-id",
				parentId: "br-parent",
			}).success,
		).toBe(false);
	});

	test("injects project_id from a grant", async () => {
		const { requests, tools } = createBranchTools({
			inject: { projectId: "granted-project", omitFromSchema: true },
		});

		await tools["branches.createAndConnect"].execute({
			name: "feature-x",
		});

		expect(requests[0].url).toBe(
			"https://console.neon.tech/api/v2/projects/granted-project/branches",
		);
	});

	test("renames the published id", () => {
		const tools = createNeonTools({
			apiKey: "test-key",
			tools: ["branches.createAndConnect"] as const,
			names: { "branches.createAndConnect": "create_branch" },
		});

		expect(tools["branches.createAndConnect"].id).toBe("create_branch");
	});

	test("uses an execute-time credential instead of the constructor credential", async () => {
		const { requests, tools } = createBranchTools({
			apiKey: "constructor-key",
		});

		await tools["branches.createAndConnect"].execute(
			{ project_id: "project-id" },
			{ apiKey: "oauth-access-token" },
		);

		expect(requests[0].headers.get("authorization")).toBe(
			"Bearer oauth-access-token",
		);
	});

	test("does not fall back to the constructor credential when execute overrides it with an empty value", async () => {
		const { requests, tools } = createBranchTools({
			apiKey: "constructor-key",
		});

		await expect(
			tools["branches.createAndConnect"].execute(
				{ project_id: "project-id" },
				{ apiKey: "" },
			),
		).rejects.toThrow("A Neon API key or OAuth access token is required");
		expect(requests).toHaveLength(0);
	});
});

describe("projects.createAndConnect", () => {
	test("posts the project body and returns the SDK workflow result", async () => {
		const requests: Request[] = [];
		const tools = createNeonTools({
			apiKey: "test-key",
			tools: ["projects.createAndConnect"] as const,
			fetch: async (input, init) => {
				requests.push(new Request(input, init));
				return jsonResponse(projectWithUriBody);
			},
		});

		const result = await tools["projects.createAndConnect"].execute({
			name: "tool-created",
			region_id: "aws-us-east-1",
		});

		expect(requests[0].method).toBe("POST");
		expect(requests[0].url).toBe(
			"https://console.neon.tech/api/v2/projects",
		);
		expect(await requests[0].json()).toEqual({
			project: {
				name: "tool-created",
				region_id: "aws-us-east-1",
			},
		});
		expect(result).toEqual({
			data: {
				project: { id: "project-id", name: "tool-created" },
				connectionString:
					"postgresql://user:pass@ep-pooler-host/neondb",
			},
		});
	});

	test("forwards pooled: false", async () => {
		const tools = createNeonTools({
			apiKey: "test-key",
			tools: ["projects.createAndConnect"] as const,
			fetch: async () => jsonResponse(projectWithUriBody),
		});

		const result = await tools["projects.createAndConnect"].execute({
			name: "tool-created",
			pooled: false,
		});

		expect(result.data.connectionString).toBe(
			"postgresql://user:pass@ep-host/neondb",
		);
	});
});

describe("createNeonTool", () => {
	test("creates a single ergonomic tool", async () => {
		const requests: Request[] = [];
		const tool = createNeonTool("branches.createAndConnect", {
			apiKey: "test-key",
			fetch: async (input, init) => {
				requests.push(new Request(input, init));
				return jsonResponse(branchWithComputeBody);
			},
		});

		await tool.execute({ project_id: "project-id", name: "feature-x" });

		expect(tool.id).toBe("create_and_connect_branches");
		expect(requests[0].url).toBe(
			"https://console.neon.tech/api/v2/projects/project-id/branches",
		);
	});
});
