import { describe, expect, test } from "vitest";
import { createNeonTools } from "../../../index.js";

const connectionStringTool = () => {
	const requests: URL[] = [];
	const tools = createNeonTools({
		apiKey: "test-key",
		tools: ["postgres.connectionString"] as const,
		fetch: async (input, init) => {
			const url = new URL(new Request(input, init).url);
			requests.push(url);
			if (url.pathname.endsWith("/branches")) {
				return Response.json({
					branches: [{ id: "br-default", default: true }],
				});
			}
			if (url.pathname.endsWith("/databases/neondb")) {
				return Response.json({
					database: { name: "neondb", owner_name: "neondb_owner" },
				});
			}
			return Response.json({ uri: "postgresql://example" });
		},
	});
	return { requests, tool: tools["postgres.connectionString"] };
};

describe("resolveConnection without a branch_id", () => {
	test("asks only for the connection URI when the database and role are given", async () => {
		const { requests, tool } = connectionStringTool();

		await tool.execute({
			project_id: "project-id",
			database_name: "neondb",
			role_name: "neondb_owner",
		});

		expect(requests.map((url) => url.pathname)).toEqual([
			"/api/v2/projects/project-id/connection_uri",
		]);
		expect(requests[0].searchParams.has("branch_id")).toBe(false);
	});

	test("asks only for the connection URI when the role is pinned and the database is given", async () => {
		const { requests, tool } = connectionStringTool();

		await tool.execute(
			{ project_id: "project-id", database_name: "neondb" },
			{ postgresRole: "app_reader" },
		);

		expect(requests.map((url) => url.pathname)).toEqual([
			"/api/v2/projects/project-id/connection_uri",
		]);
		expect(requests[0].searchParams.get("role_name")).toBe("app_reader");
	});

	test("still finds the default branch to read the database owner", async () => {
		const { requests, tool } = connectionStringTool();

		await tool.execute({
			project_id: "project-id",
			database_name: "neondb",
		});

		expect(requests.map((url) => url.pathname)).toEqual([
			"/api/v2/projects/project-id/branches",
			"/api/v2/projects/project-id/branches/br-default/databases/neondb",
			"/api/v2/projects/project-id/connection_uri",
		]);
		expect(requests[2].searchParams.get("branch_id")).toBe("br-default");
		expect(requests[2].searchParams.get("role_name")).toBe("neondb_owner");
	});
});
