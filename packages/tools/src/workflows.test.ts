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
		tools: ["branches.createWithCompute"] as const,
		fetch: async (input, init) => {
			requests.push(new Request(input, init));
			return jsonResponse(branchWithComputeBody);
		},
	});
	return { requests, tools };
};

describe("branches.createWithCompute", () => {
	test("creates only the selected tool", () => {
		const tools = createNeonTools({
			apiKey: "test-key",
			tools: ["branches.createWithCompute"] as const,
		});

		expect(Object.keys(tools)).toEqual(["branches.createWithCompute"]);
		expect(tools["branches.createWithCompute"].id).toBe(
			"create_with_compute_branches",
		);
		expect(tools["branches.createWithCompute"].operationId).toBe(
			"branches.createWithCompute",
		);
		expect(tools["branches.createWithCompute"].requiresApproval).toBe(true);
		expect(tools["branches.createWithCompute"].annotations).toEqual({
			readOnlyHint: false,
			destructiveHint: true,
			openWorldHint: true,
		});
	});

	test("posts a read-write endpoint and returns the SDK workflow result", async () => {
		const { requests, tools } = createBranchTools();

		const result = await tools["branches.createWithCompute"].execute({
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

		const result = await tools["branches.createWithCompute"].execute({
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
			tools["branches.createWithCompute"].execute(
				{ project_id: "project-id" },
				{ signal: controller.signal },
			),
		).rejects.toThrow();
	});

	test("describes pooled on the published schema", () => {
		const { tools } = createBranchTools();
		const schema = z.toJSONSchema(
			tools["branches.createWithCompute"].inputSchema,
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
			tools["branches.createWithCompute"].inputSchema.safeParse({
				project_id: "project-id",
				parentId: "br-parent",
			}).success,
		).toBe(false);
	});

	test("injects project_id from a grant", async () => {
		const { requests, tools } = createBranchTools({
			inject: { projectId: "granted-project", omitFromSchema: true },
		});

		await tools["branches.createWithCompute"].execute({
			name: "feature-x",
		});

		expect(requests[0].url).toBe(
			"https://console.neon.tech/api/v2/projects/granted-project/branches",
		);
	});

	test("renames the published id", () => {
		const tools = createNeonTools({
			apiKey: "test-key",
			tools: ["branches.createWithCompute"] as const,
			names: { "branches.createWithCompute": "create_branch" },
		});

		expect(tools["branches.createWithCompute"].id).toBe("create_branch");
	});

	test("uses an execute-time credential instead of the constructor credential", async () => {
		const { requests, tools } = createBranchTools({
			apiKey: "constructor-key",
		});

		await tools["branches.createWithCompute"].execute(
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
			tools["branches.createWithCompute"].execute(
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
		const tool = createNeonTool("branches.createWithCompute", {
			apiKey: "test-key",
			fetch: async (input, init) => {
				requests.push(new Request(input, init));
				return jsonResponse(branchWithComputeBody);
			},
		});

		await tool.execute({ project_id: "project-id", name: "feature-x" });

		expect(tool.id).toBe("create_with_compute_branches");
		expect(requests[0].url).toBe(
			"https://console.neon.tech/api/v2/projects/project-id/branches",
		);
	});
});
