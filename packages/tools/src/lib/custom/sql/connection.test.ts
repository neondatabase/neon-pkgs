import { NeonClientError } from "@neon/sdk";
import { describe, expect, test } from "vitest";
import { createNeonTools } from "../../../index.js";

const DATABASES = [
	{ name: "neondb", owner_name: "neondb_owner" },
	{ name: "analytics", owner_name: "analyst" },
];

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
			if (url.pathname.endsWith("/databases")) {
				return Response.json({ databases: DATABASES });
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
			"/api/v2/projects/project-id/branches/br-default/databases",
			"/api/v2/projects/project-id/connection_uri",
		]);
		expect(requests[2].searchParams.get("branch_id")).toBe("br-default");
		expect(requests[2].searchParams.get("role_name")).toBe("neondb_owner");
	});

	test("logs in as the owner of the database it names", async () => {
		const { requests, tool } = connectionStringTool();

		await tool.execute({
			project_id: "project-id",
			database_name: "analytics",
		});

		expect(requests.at(-1)?.searchParams.get("role_name")).toBe("analyst");
	});
});

describe("resolveConnection with a database the branch does not list", () => {
	test.each([
		[
			"postgres",
			'Neon reserves the "postgres" database and does not list it on this branch, so the tools cannot look up its owner to log in as. Pass role_name to connect to it anyway. The branch\'s databases: "neondb", "analytics".',
		],
		[
			"nedb",
			'The Neon API does not list database "nedb" on this branch. The branch\'s databases: "neondb", "analytics".',
		],
	])("names the branch's databases for %s", async (databaseName, message) => {
		const { requests, tool } = connectionStringTool();

		const call = tool.execute({
			project_id: "project-id",
			branch_id: "br-default",
			database_name: databaseName,
		});

		await expect(call).rejects.toBeInstanceOf(NeonClientError);
		await expect(call).rejects.toThrow(message);
		expect(
			requests.some((url) => url.pathname.endsWith("/connection_uri")),
		).toBe(false);
	});
});
