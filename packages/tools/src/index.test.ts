import { describe, expect, test } from "vitest";
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
			limit: 1,
			search: "demo",
		});

		expect(result).toEqual({
			data: { projects: [], pagination: {} },
		});
		expect(requests).toHaveLength(1);
		expect(requests[0].method).toBe("GET");
		expect(requests[0].url).toBe(
			"https://console.neon.tech/api/v2/projects?limit=1&search=demo",
		);
		expect(requests[0].headers.get("authorization")).toBe(
			"Bearer test-key",
		);

		expect(
			tools.listProjects.inputSchema.safeParse({
				limit: "one",
			}).success,
		).toBe(false);
		expect(
			tools.listProjects.inputSchema.safeParse({
				serch: "demo",
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
			name: "tool-created",
		});

		expect(requests[0].method).toBe("POST");
		expect(await requests[0].json()).toEqual({
			project: { name: "tool-created" },
		});
		expect(
			tools.createProject.inputSchema.safeParse({
				nmae: "tool-created",
			}).success,
		).toBe(false);
		expect(tools.createProject.requiresApproval).toBe(true);
		expect(tools.createProject.annotations.readOnlyHint).toBe(false);
		expect(tools.createProject.annotations.destructiveHint).toBe(true);
	});

	test("omits an empty optional lifted body", async () => {
		const requests: Request[] = [];
		const tools = createNeonTools({
			apiKey: "test-key",
			operations: ["updateProjectBranchDataAPI"] as const,
			fetch: async (input, init) => {
				requests.push(new Request(input, init));
				return jsonResponse({});
			},
		});

		await tools.updateProjectBranchDataAPI.execute({
			project_id: "project-id",
			branch_id: "branch-id",
			database_name: "neondb",
		});

		expect(requests[0].headers.get("content-type")).toBeNull();
		expect(await requests[0].text()).toBe("");
	});

	test("sends restoreSnapshot name in the body only", async () => {
		const requests: Request[] = [];
		const tools = createNeonTools({
			apiKey: "test-key",
			operations: ["restoreSnapshot"] as const,
			fetch: async (input, init) => {
				requests.push(new Request(input, init));
				return jsonResponse({ branch: { id: "br-id" } });
			},
		});

		await tools.restoreSnapshot.execute({
			project_id: "project-id",
			snapshot_id: "snapshot-id",
			name: "restored",
		});

		expect(requests[0].url).toBe(
			"https://console.neon.tech/api/v2/projects/project-id/snapshots/snapshot-id/restore",
		);
		expect(requests[0].url).not.toContain("name=");
		expect(await requests[0].json()).toEqual({ name: "restored" });
	});

	test("rejects duplicate operation selections", () => {
		expect(() =>
			createNeonTools({
				apiKey: "test-key",
				operations: ["listProjects", "listProjects"],
			}),
		).toThrow('Duplicate Neon operation "listProjects"');
	});

	test("reports unknown runtime operation ids", () => {
		expect(() =>
			Reflect.apply(createNeonTools, undefined, [
				{ apiKey: "test-key", operations: ["listProjcts"] },
			]),
		).toThrow('Unknown Neon operation "listProjcts"');
		expect(() =>
			Reflect.apply(createNeonTool, undefined, [
				"listProjcts",
				{ apiKey: "test-key" },
			]),
		).toThrow('Unknown Neon operation or workflow "listProjcts"');
	});
});

describe("Bearer credentials", () => {
	const listProjects = (options: NeonToolsClientOptions) => {
		const requests: Request[] = [];
		const tools = createNeonTools({
			...options,
			operations: ["listProjects"] as const,
			fetch: async (input, init) => {
				requests.push(new Request(input, init));
				return jsonResponse({ projects: [], pagination: {} });
			},
		});
		return { requests, tools };
	};

	test("sends an OAuth access token as a Bearer credential", async () => {
		const { requests, tools } = listProjects({
			apiKey: "oauth-access-token",
		});

		await tools.listProjects.execute({});

		expect(requests[0].headers.get("authorization")).toBe(
			"Bearer oauth-access-token",
		);
	});

	test("resolves a credential getter on every execute", async () => {
		let issued = 0;
		const { requests, tools } = listProjects({
			apiKey: () => {
				issued += 1;
				return `oauth-access-token-${issued}`;
			},
		});

		await tools.listProjects.execute({});
		await tools.listProjects.execute({});

		expect(issued).toBeGreaterThanOrEqual(2);
		expect(requests).toHaveLength(2);
		expect(requests[0].headers.get("authorization")).toMatch(
			/^Bearer oauth-access-token-\d+$/,
		);
		expect(requests[1].headers.get("authorization")).toMatch(
			/^Bearer oauth-access-token-\d+$/,
		);
		expect(requests[1].headers.get("authorization")).not.toBe(
			requests[0].headers.get("authorization"),
		);
	});

	test("uses an execute-time credential instead of the constructor credential", async () => {
		const { requests, tools } = listProjects({
			apiKey: "constructor-key",
		});

		await tools.listProjects.execute({}, { apiKey: "oauth-access-token" });

		expect(requests[0].headers.get("authorization")).toBe(
			"Bearer oauth-access-token",
		);
	});

	test("keeps concurrent execute-time credentials isolated", async () => {
		const { requests, tools } = listProjects({
			apiKey: "constructor-key",
		});

		await Promise.all([
			tools.listProjects.execute({}, { apiKey: "oauth-token-a" }),
			tools.listProjects.execute({}, { apiKey: "oauth-token-b" }),
		]);

		expect(
			[
				...requests.map((request) =>
					request.headers.get("authorization"),
				),
			].sort(),
		).toEqual(["Bearer oauth-token-a", "Bearer oauth-token-b"]);
	});

	test("requires a credential at execute when none was given at construction", async () => {
		const { requests, tools } = listProjects({});

		await expect(tools.listProjects.execute({})).rejects.toThrow(
			"A Neon API key or OAuth access token is required",
		);
		expect(requests).toHaveLength(0);
	});

	test("does not fall back to the constructor credential when execute overrides it with an empty value", async () => {
		const { requests, tools } = listProjects({
			apiKey: "constructor-key",
		});

		await expect(
			tools.listProjects.execute({}, { apiKey: "" }),
		).rejects.toThrow("A Neon API key or OAuth access token is required");
		expect(requests).toHaveLength(0);
	});

	test("does not fall back to the constructor credential when an execute-time getter resolves empty", async () => {
		const { requests, tools } = listProjects({
			apiKey: "constructor-key",
		});

		await expect(
			tools.listProjects.execute({}, { apiKey: () => "" }),
		).rejects.toThrow("A Neon API key or OAuth access token is required");
		expect(requests).toHaveLength(0);
	});
});
