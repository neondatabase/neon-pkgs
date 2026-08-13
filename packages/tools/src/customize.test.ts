import { describe, expect, test } from "vitest";
import * as z from "zod";
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

const getProjectTools = (options: NeonToolsClientOptions = {}) => {
	const requests: Request[] = [];
	const tools = createNeonTools({
		apiKey: "test-key",
		...options,
		operations: ["getProject"] as const,
		fetch: async (input, init) => {
			requests.push(new Request(input, init));
			return jsonResponse({ project: { id: "project-id" } });
		},
	});
	return { requests, tools };
};

describe("description overrides", () => {
	test("replaces by operationId and leaves unmatched tools unchanged", () => {
		const tools = createNeonTools({
			apiKey: "test-key",
			operations: ["listProjects", "getProject"] as const,
			descriptions: {
				listProjects: "List Neon projects in your account.",
			},
		});

		expect(tools.listProjects.description).toBe(
			"List Neon projects in your account.",
		);
		expect(tools.getProject.description).toBe(
			createNeonTool("getProject", { apiKey: "test-key" }).description,
		);
	});

	test("replaces by snake-case id when operationId is absent", () => {
		const tools = createNeonTools({
			apiKey: "test-key",
			operations: ["listProjects"] as const,
			descriptions: {
				list_projects: "List Neon projects in your account.",
			},
		});

		expect(tools.listProjects.description).toBe(
			"List Neon projects in your account.",
		);
	});

	test("prefers operationId over snake-case id", () => {
		const tools = createNeonTools({
			apiKey: "test-key",
			operations: ["listProjects"] as const,
			descriptions: {
				listProjects: "from operationId",
				list_projects: "from id",
			},
		});

		expect(tools.listProjects.description).toBe("from operationId");
	});

	test("lets a function alter the generated description", () => {
		const tools = createNeonTools({
			apiKey: "test-key",
			operations: ["listProjects"] as const,
			descriptions: (tool) => `${tool.description}\nNotice: scoped.`,
		});

		expect(tools.listProjects.description).toContain("Notice: scoped.");
		expect(tools.listProjects.description.startsWith("Retrieves")).toBe(
			true,
		);
	});

	test("rejects a non-string description function result", () => {
		expect(() =>
			createNeonTools({
				apiKey: "test-key",
				operations: ["listProjects"] as const,
				descriptions: () => 1 as unknown as string,
			}),
		).toThrow("Neon tool description overrides must return a string");
	});
});

describe("onExecute", () => {
	test("wraps execute so the host can track the call", async () => {
		const events: string[] = [];
		const { requests, tools } = getProjectTools({
			onExecute: async ({ operationId, id, execute }) => {
				events.push(`start:${operationId}:${id}`);
				const result = await execute();
				events.push("success");
				return result;
			},
		});

		const result = await tools.getProject.execute({
			path: { project_id: "project-id" },
		});

		expect(events).toEqual(["start:getProject:get_project", "success"]);
		expect(result).toEqual({ data: { project: { id: "project-id" } } });
		expect(requests).toHaveLength(1);
	});

	test("observes injection, validation, and fetch failures", async () => {
		const seen: string[] = [];
		const { requests, tools } = getProjectTools({
			inject: { projectId: "not valid", omitFromSchema: true },
			onExecute: async ({ execute }) => {
				seen.push("start");
				try {
					return await execute();
				} catch (error) {
					seen.push(
						error instanceof Error ? error.message : String(error),
					);
					throw error;
				}
			},
		});

		await expect(tools.getProject.execute({})).rejects.toThrow();
		expect(seen[0]).toBe("start");
		expect(seen[1]).toEqual(expect.stringMatching(/Invalid|project_id/i));
		expect(requests).toHaveLength(0);
	});

	test("does not let mutated event.input change a grant-locked project", async () => {
		const { requests, tools } = getProjectTools({
			inject: {
				projectId: "granted-project",
				omitFromSchema: true,
			},
			onExecute: async ({ input, execute }) => {
				(input as { path?: { project_id: string } }).path = {
					project_id: "attacker-project",
				};
				return execute();
			},
		});

		await tools.getProject.execute({});

		expect(requests[0].url).toBe(
			"https://console.neon.tech/api/v2/projects/granted-project",
		);
	});

	test("forwards execute-time credentials and abort signals", async () => {
		const requests: Request[] = [];
		const controller = new AbortController();
		const tools = createNeonTools({
			apiKey: "constructor-key",
			operations: ["getProject"] as const,
			onExecute: ({ execute }) => execute(),
			fetch: async (input, init) => {
				requests.push(new Request(input, init));
				return jsonResponse({ project: { id: "project-id" } });
			},
		});

		await tools.getProject.execute(
			{ path: { project_id: "project-id" } },
			{ apiKey: "oauth-access-token", signal: controller.signal },
		);

		expect(requests[0].headers.get("authorization")).toBe(
			"Bearer oauth-access-token",
		);
		controller.abort();
		expect(requests[0].signal.aborted).toBe(true);
	});
});

describe("path injection", () => {
	test("fills a missing project_id and optionalizes it on the published schema", async () => {
		const { requests, tools } = getProjectTools({
			inject: { projectId: "granted-project" },
		});

		await tools.getProject.execute({});

		expect(requests[0].url).toBe(
			"https://console.neon.tech/api/v2/projects/granted-project",
		);
		const schema = z.toJSONSchema(tools.getProject.inputSchema);
		expect(schema).toMatchObject({
			type: "object",
			properties: {
				path: {
					type: "object",
					properties: {
						project_id: { type: "string" },
					},
				},
			},
		});
		expect(schema.required).toBeUndefined();
		expect(
			(
				schema.properties as {
					path: { required?: string[] };
				}
			).path.required,
		).toBeUndefined();
	});

	test("lets a caller-supplied project_id win when the field stays on the schema", async () => {
		let getterCalls = 0;
		const { requests, tools } = getProjectTools({
			inject: {
				projectId: () => {
					getterCalls += 1;
					return "granted-project";
				},
			},
		});

		await tools.getProject.execute({
			path: { project_id: "caller-project" },
		});

		expect(getterCalls).toBe(0);
		expect(requests[0].url).toBe(
			"https://console.neon.tech/api/v2/projects/caller-project",
		);
	});

	test("omits injected keys from the published schema and always uses the injector", async () => {
		const { requests, tools } = getProjectTools({
			inject: {
				projectId: "granted-project",
				omitFromSchema: true,
			},
		});

		await tools.getProject.execute({
			path: { project_id: "caller-project" },
		});

		expect(requests[0].url).toBe(
			"https://console.neon.tech/api/v2/projects/granted-project",
		);
		const schema = z.toJSONSchema(tools.getProject.inputSchema);
		expect(schema.properties).toEqual({});
		expect(schema.required).toBeUndefined();
	});

	test("keeps remaining path fields when only project_id is omitted", async () => {
		const requests: Request[] = [];
		const tools = createNeonTools({
			apiKey: "test-key",
			operations: ["deleteProjectBranch"] as const,
			inject: {
				projectId: "granted-project",
				omitFromSchema: true,
			},
			fetch: async (input, init) => {
				requests.push(new Request(input, init));
				return jsonResponse({ branch: { id: "br-id" } });
			},
		});

		await tools.deleteProjectBranch.execute({
			path: { branch_id: "br-id" },
		});

		expect(requests[0].url).toBe(
			"https://console.neon.tech/api/v2/projects/granted-project/branches/br-id",
		);
		const schema = z.toJSONSchema(tools.deleteProjectBranch.inputSchema);
		const pathSchema = (
			schema.properties as {
				path: {
					properties: Record<string, unknown>;
					required?: string[];
				};
			}
		).path;
		expect(Object.keys(pathSchema.properties)).toEqual(["branch_id"]);
		expect(pathSchema.required).toEqual(["branch_id"]);
		expect(schema.required).toEqual(["path"]);
	});

	test("injects both path ids when both injectors are configured", async () => {
		const requests: Request[] = [];
		const tools = createNeonTools({
			apiKey: "test-key",
			operations: ["deleteProjectBranch"] as const,
			inject: {
				projectId: "granted-project",
				branchId: "granted-branch",
				omitFromSchema: true,
			},
			fetch: async (input, init) => {
				requests.push(new Request(input, init));
				return jsonResponse({ branch: { id: "granted-branch" } });
			},
		});

		await tools.deleteProjectBranch.execute({});

		expect(requests[0].url).toBe(
			"https://console.neon.tech/api/v2/projects/granted-project/branches/granted-branch",
		);
	});

	test("does not add a path object to tools that have no project_id", async () => {
		const requests: Request[] = [];
		let getterCalls = 0;
		const tools = createNeonTools({
			apiKey: "test-key",
			operations: ["listProjects"] as const,
			inject: {
				projectId: () => {
					getterCalls += 1;
					return "granted-project";
				},
			},
			fetch: async (input, init) => {
				requests.push(new Request(input, init));
				return jsonResponse({ projects: [], pagination: {} });
			},
		});

		await tools.listProjects.execute({ query: { limit: 1 } });

		expect(getterCalls).toBe(0);
		expect(requests[0].url).toBe(
			"https://console.neon.tech/api/v2/projects?limit=1",
		);
		expect(
			z.toJSONSchema(tools.listProjects.inputSchema).properties,
		).not.toHaveProperty("path");
	});

	test("rejects an empty static inject value at construction", () => {
		expect(() =>
			createNeonTools({
				apiKey: "test-key",
				operations: ["getProject"] as const,
				inject: { projectId: "" },
			}),
		).toThrow("A projectId inject value is required");
	});

	test("rejects omitFromSchema without an injector at construction", () => {
		expect(() =>
			createNeonTools({
				apiKey: "test-key",
				operations: ["getProject"] as const,
				inject: { omitFromSchema: true },
			}),
		).toThrow(
			"omitFromSchema requires inject.projectId or inject.branchId",
		);
	});

	test("fails closed when an omitted injector returns nothing", async () => {
		const { requests, tools } = getProjectTools({
			inject: {
				projectId: () => undefined,
				omitFromSchema: true,
			},
		});

		await expect(tools.getProject.execute({})).rejects.toThrow(
			"A projectId inject value is required",
		);
		expect(requests).toHaveLength(0);
	});

	test("lets the original schema reject an invalid injected id before fetch", async () => {
		const { requests, tools } = getProjectTools({
			inject: { projectId: "NOT VALID", omitFromSchema: true },
		});

		await expect(tools.getProject.execute({})).rejects.toThrow();
		expect(requests).toHaveLength(0);
	});

	test("does not normalize a malformed path into a valid request", async () => {
		const { requests, tools } = getProjectTools({
			inject: { projectId: "granted-project" },
		});

		await expect(
			tools.getProject.execute({ path: "nope" } as never),
		).rejects.toThrow();
		expect(requests).toHaveLength(0);
	});

	test("resolves async getters", async () => {
		const { requests, tools } = getProjectTools({
			inject: {
				projectId: async () => "granted-project",
				omitFromSchema: true,
			},
		});

		await tools.getProject.execute({});

		expect(requests[0].url).toBe(
			"https://console.neon.tech/api/v2/projects/granted-project",
		);
	});

	test("applies the same inject options on createNeonTool", async () => {
		const requests: Request[] = [];
		const tool = createNeonTool("getProject", {
			apiKey: "test-key",
			inject: { projectId: "granted-project", omitFromSchema: true },
			fetch: async (input, init) => {
				requests.push(new Request(input, init));
				return jsonResponse({ project: { id: "project-id" } });
			},
		});

		await tool.execute({});

		expect(requests[0].url).toBe(
			"https://console.neon.tech/api/v2/projects/granted-project",
		);
	});
});
