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
			tools: ["projects.createAndConnect"],
			fetch: async (input, init) => {
				const request =
					input instanceof Request ? input : new Request(input, init);
				signals.push(request.signal);
				controller.abort();
				throw (
					request.signal.reason ??
					new DOMException("Aborted", "AbortError")
				);
			},
		});

		const config = toEveTool(tools["projects.createAndConnect"]);
		const tool = defineTool(config);

		expect(tool.description).toBe(
			tools["projects.createAndConnect"].description,
		);
		expect(typeof tool.approval).toBe("function");
		await expect(
			config.execute(
				{ name: "from-eve" },
				{ abortSignal: controller.signal },
			),
		).rejects.toThrow();
		expect(signals[0].aborted).toBe(true);
	});

	test("does not gate ordinary read operations", () => {
		const tools = createNeonTools({
			apiKey: "test-key",
			tools: ["projects.list"],
		});

		expect(toEveTool(tools["projects.list"]).approval).toBeUndefined();
	});
});

describe("Mastra compatibility", () => {
	test("produces createTool-compatible records with approval metadata", () => {
		const tools = createNeonTools({
			apiKey: "test-key",
			tools: ["projects.list", "projects.createAndConnect"],
		});

		const configs = toMastraTools(tools);
		const listProjects = createTool(configs.projects_list);
		const createProject = createTool(configs.projects_create_and_connect);

		expect(listProjects.id).toBe("projects_list");
		expect(listProjects.requireApproval).toBe(false);
		expect(createProject.id).toBe("projects_create_and_connect");
		expect(createProject.requireApproval).toBe(true);
	});

	test("forwards omitted path schemas from inject", () => {
		const tools = createNeonTools({
			apiKey: "test-key",
			tools: ["projects.get"],
			inject: { projectId: "granted-project", omitFromSchema: true },
		});

		expect(toMastraTools(tools).projects_get.inputSchema).toBe(
			tools["projects.get"].inputSchema,
		);
		expect(toEveTool(tools["projects.get"]).inputSchema).toBe(
			tools["projects.get"].inputSchema,
		);
	});

	test("executes an omitted project tool through Eve and Mastra", async () => {
		const requests: Request[] = [];
		const tools = createNeonTools({
			apiKey: "test-key",
			tools: ["projects.get"],
			descriptions: { projects_get: "Granted project details." },
			inject: { projectId: "granted-project", omitFromSchema: true },
			fetch: async (input, init) => {
				requests.push(new Request(input, init));
				return jsonResponse({ project: { id: "granted-project" } });
			},
		});

		const eve = toEveTool(tools["projects.get"]);
		const mastra = toMastraTools(tools).projects_get;
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
