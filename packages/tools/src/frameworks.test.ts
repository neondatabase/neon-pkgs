import { createTool } from "@mastra/core/tools";
import { defineTool } from "eve/tools";
import { describe, expect, test } from "vitest";
import { toEveTool } from "./eve.js";
import { createNeonTools } from "./index.js";
import { toMastraTools } from "./mastra.js";

const jsonResponse = (body: unknown) =>
	new Response(JSON.stringify(body), {
		headers: { "content-type": "application/json" },
	});

describe("Eve compatibility", () => {
	test("produces a defineTool-compatible config with approval and cancellation", async () => {
		const signals: AbortSignal[] = [];
		const controller = new AbortController();
		const tools = createNeonTools({
			apiKey: "test-key",
			operations: ["createProject"],
			fetch: async (input, init) => {
				signals.push(new Request(input, init).signal);
				return jsonResponse({ project: { id: "project-id" } });
			},
		});

		const config = toEveTool(tools.createProject);
		const tool = defineTool(config);

		expect(tool.description).toBe(tools.createProject.description);
		expect(typeof tool.approval).toBe("function");
		await config.execute(
			{ body: { project: { name: "from-eve" } } },
			{ abortSignal: controller.signal },
		);
		controller.abort();
		expect(signals[0].aborted).toBe(true);
	});

	test("does not gate ordinary read operations", () => {
		const tools = createNeonTools({
			apiKey: "test-key",
			operations: ["listProjects"],
		});

		expect(toEveTool(tools.listProjects).approval).toBeUndefined();
	});
});

describe("Mastra compatibility", () => {
	test("produces createTool-compatible records with approval metadata", () => {
		const tools = createNeonTools({
			apiKey: "test-key",
			operations: ["listProjects", "createProject"],
		});

		const configs = toMastraTools(tools);
		const listProjects = createTool(configs.list_projects);
		const createProject = createTool(configs.create_project);

		expect(listProjects.id).toBe("list_projects");
		expect(listProjects.requireApproval).toBe(false);
		expect(createProject.id).toBe("create_project");
		expect(createProject.requireApproval).toBe(true);
	});

	test("forwards omitted path schemas from inject", () => {
		const tools = createNeonTools({
			apiKey: "test-key",
			operations: ["getProject"],
			inject: { projectId: "granted-project", omitFromSchema: true },
		});

		expect(toMastraTools(tools).get_project.inputSchema).toBe(
			tools.getProject.inputSchema,
		);
		expect(toEveTool(tools.getProject).inputSchema).toBe(
			tools.getProject.inputSchema,
		);
	});

	test("executes an omitted project tool through Eve and Mastra", async () => {
		const requests: Request[] = [];
		const tools = createNeonTools({
			apiKey: "test-key",
			operations: ["getProject"],
			descriptions: { get_project: "Granted project details." },
			inject: { projectId: "granted-project", omitFromSchema: true },
			fetch: async (input, init) => {
				requests.push(new Request(input, init));
				return jsonResponse({ project: { id: "granted-project" } });
			},
		});

		const eve = toEveTool(tools.getProject);
		const mastra = toMastraTools(tools).get_project;
		expect(eve.description).toBe("Granted project details.");
		expect(mastra.description).toBe("Granted project details.");

		await eve.execute({}, { abortSignal: new AbortController().signal });
		await mastra.execute({}, {});

		expect(requests).toHaveLength(2);
		expect(requests[0].url).toBe(
			"https://console.neon.tech/api/v2/projects/granted-project",
		);
		expect(requests[1].url).toBe(
			"https://console.neon.tech/api/v2/projects/granted-project",
		);
	});
});
