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

const createBranchTools = (options: NeonToolsClientOptions = {}) => {
	const requests: Request[] = [];
	const tools = createNeonTools({
		apiKey: "test-key",
		...options,
		workflows: ["createBranchWithCompute"] as const,
		fetch: async (input, init) => {
			requests.push(new Request(input, init));
			return jsonResponse(branchWithComputeBody);
		},
	});
	return { requests, tools };
};

describe("createNeonTools workflows", () => {
	test("creates only the selected workflow", () => {
		const tools = createNeonTools({
			apiKey: "test-key",
			workflows: ["createBranchWithCompute"] as const,
		});

		expect(Object.keys(tools)).toEqual(["createBranchWithCompute"]);
		expect(tools.createBranchWithCompute.id).toBe(
			"create_branch_with_compute",
		);
		expect(tools.createBranchWithCompute.operationId).toBe(
			"createBranchWithCompute",
		);
		expect(tools.createBranchWithCompute.requiresApproval).toBe(true);
		expect(tools.createBranchWithCompute.annotations).toEqual({
			readOnlyHint: false,
			destructiveHint: true,
			openWorldHint: true,
		});
	});

	test("merges operations and workflows on one record", () => {
		const tools = createNeonTools({
			apiKey: "test-key",
			operations: ["listProjects"] as const,
			workflows: ["createBranchWithCompute"] as const,
		});

		expect(Object.keys(tools)).toEqual([
			"listProjects",
			"createBranchWithCompute",
		]);
	});

	test("rejects a call with neither operations nor workflows", () => {
		expect(() =>
			Reflect.apply(createNeonTools, undefined, [{ apiKey: "test-key" }]),
		).toThrow(
			"createNeonTools requires at least one operation or workflow",
		);
	});

	test("rejects duplicate workflow selections", () => {
		expect(() =>
			createNeonTools({
				apiKey: "test-key",
				workflows: [
					"createBranchWithCompute",
					"createBranchWithCompute",
				],
			}),
		).toThrow('Duplicate Neon workflow "createBranchWithCompute"');
	});

	test("reports unknown runtime workflow ids", () => {
		expect(() =>
			Reflect.apply(createNeonTools, undefined, [
				{ apiKey: "test-key", workflows: ["createWithComput"] },
			]),
		).toThrow('Unknown Neon workflow "createWithComput"');
		expect(() =>
			Reflect.apply(createNeonTool, undefined, [
				"createWithComput",
				{ apiKey: "test-key" },
			]),
		).toThrow('Unknown Neon operation or workflow "createWithComput"');
	});

	test("rejects a published-id collision between an operation and a workflow", () => {
		expect(() =>
			createNeonTools({
				apiKey: "test-key",
				operations: ["createProject"] as const,
				workflows: ["createProjectAndConnect"] as const,
				names: { createProjectAndConnect: "create_project" },
			}),
		).toThrow(
			'Duplicate Neon tool id "create_project" for createProject, createProjectAndConnect',
		);
	});
});

describe("createBranchWithCompute", () => {
	test("posts a read-write endpoint and returns the SDK workflow result", async () => {
		const { requests, tools } = createBranchTools();

		const result = await tools.createBranchWithCompute.execute({
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

		const result = await tools.createBranchWithCompute.execute({
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
			tools.createBranchWithCompute.execute(
				{ project_id: "project-id" },
				{ signal: controller.signal },
			),
		).rejects.toThrow();
	});

	test("describes pooled on the published schema", () => {
		const { tools } = createBranchTools();
		const schema = z.toJSONSchema(
			tools.createBranchWithCompute.inputSchema,
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
			tools.createBranchWithCompute.inputSchema.safeParse({
				project_id: "project-id",
				parentId: "br-parent",
			}).success,
		).toBe(false);
	});

	test("injects project_id from a grant", async () => {
		const { requests, tools } = createBranchTools({
			inject: { projectId: "granted-project", omitFromSchema: true },
		});

		await tools.createBranchWithCompute.execute({ name: "feature-x" });

		expect(requests[0].url).toBe(
			"https://console.neon.tech/api/v2/projects/granted-project/branches",
		);
	});

	test("renames the published id", () => {
		const tools = createNeonTools({
			apiKey: "test-key",
			workflows: ["createBranchWithCompute"] as const,
			names: { createBranchWithCompute: "create_branch" },
		});

		expect(tools.createBranchWithCompute.id).toBe("create_branch");
	});

	test("uses an execute-time credential instead of the constructor credential", async () => {
		const { requests, tools } = createBranchTools({
			apiKey: "constructor-key",
		});

		await tools.createBranchWithCompute.execute(
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
			tools.createBranchWithCompute.execute(
				{ project_id: "project-id" },
				{ apiKey: "" },
			),
		).rejects.toThrow("A Neon API key or OAuth access token is required");
		expect(requests).toHaveLength(0);
	});

	test("does not fall back to the constructor credential when an execute-time getter resolves empty", async () => {
		const { requests, tools } = createBranchTools({
			apiKey: "constructor-key",
		});

		await expect(
			tools.createBranchWithCompute.execute(
				{ project_id: "project-id" },
				{ apiKey: () => "" },
			),
		).rejects.toThrow("A Neon API key or OAuth access token is required");
		expect(requests).toHaveLength(0);
	});
});

describe("createProjectAndConnect", () => {
	test("posts the project body and returns the SDK workflow result", async () => {
		const requests: Request[] = [];
		const tools = createNeonTools({
			apiKey: "test-key",
			workflows: ["createProjectAndConnect"] as const,
			fetch: async (input, init) => {
				requests.push(new Request(input, init));
				return jsonResponse(projectWithUriBody);
			},
		});

		const result = await tools.createProjectAndConnect.execute({
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
			workflows: ["createProjectAndConnect"] as const,
			fetch: async () => jsonResponse(projectWithUriBody),
		});

		const result = await tools.createProjectAndConnect.execute({
			name: "tool-created",
			pooled: false,
		});

		expect(result.data.connectionString).toBe(
			"postgresql://user:pass@ep-host/neondb",
		);
	});
});

describe("createNeonTool workflow", () => {
	test("creates a single workflow tool", async () => {
		const requests: Request[] = [];
		const tool = createNeonTool("createBranchWithCompute", {
			apiKey: "test-key",
			fetch: async (input, init) => {
				requests.push(new Request(input, init));
				return jsonResponse(branchWithComputeBody);
			},
		});

		await tool.execute({ project_id: "project-id", name: "feature-x" });

		expect(tool.id).toBe("create_branch_with_compute");
		expect(requests[0].url).toBe(
			"https://console.neon.tech/api/v2/projects/project-id/branches",
		);
	});
});
