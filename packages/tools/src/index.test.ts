import { describe, expect, test } from "vitest";
import { createNeonTools } from "./index.js";

const jsonResponse = (body: unknown, status = 200) =>
	new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});

describe("createNeonTools", () => {
	test("creates only the explicitly selected operations", () => {
		const tools = createNeonTools({
			apiKey: "test-key",
			operations: ["listProjects", "createProject"] as const,
		});

		expect(Object.keys(tools)).toEqual(["listProjects", "createProject"]);
		expect(tools.listProjects.id).toBe("list_projects");
		expect(tools.createProject.id).toBe("create_project");
	});

	test("validates input and maps a GET tool to the raw SDK operation", async () => {
		const requests: Request[] = [];
		const tools = createNeonTools({
			apiKey: "test-key",
			operations: ["listProjects"] as const,
			fetch: async (input, init) => {
				requests.push(new Request(input, init));
				return jsonResponse({ projects: [], pagination: {} });
			},
		});

		const result = await tools.listProjects.execute({
			query: { limit: 1, search: "demo" },
		});

		expect(result).toEqual({
			data: { projects: [], pagination: {} },
		});
		expect(requests).toHaveLength(1);
		expect(requests[0].method).toBe("GET");
		expect(requests[0].url).toBe(
			"https://console.neon.tech/api/v2/projects?limit=1&search=demo&recoverable=false",
		);
		expect(requests[0].headers.get("authorization")).toBe(
			"Bearer test-key",
		);

		expect(
			tools.listProjects.inputSchema.safeParse({
				query: { limit: "one" },
			}).success,
		).toBe(false);
	});

	test("maps a POST body and exposes conservative write metadata", async () => {
		const requests: Request[] = [];
		const tools = createNeonTools({
			apiKey: "test-key",
			operations: ["createProject"] as const,
			fetch: async (input, init) => {
				requests.push(new Request(input, init));
				return jsonResponse({ project: { id: "project-id" } });
			},
		});

		await tools.createProject.execute({
			body: { project: { name: "tool-created" } },
		});

		expect(requests[0].method).toBe("POST");
		expect(await requests[0].json()).toEqual({
			project: { name: "tool-created", pg_version: 18 },
		});
		expect(tools.createProject.requiresApproval).toBe(true);
		expect(tools.createProject.annotations.readOnlyHint).toBe(false);
		expect(tools.createProject.annotations.destructiveHint).toBe(true);
	});

	test("rejects duplicate operation selections", () => {
		expect(() =>
			createNeonTools({
				apiKey: "test-key",
				operations: ["listProjects", "listProjects"],
			}),
		).toThrow('Duplicate Neon operation "listProjects"');
	});
});
