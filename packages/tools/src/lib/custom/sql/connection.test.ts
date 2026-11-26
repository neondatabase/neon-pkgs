import { types } from "@neondatabase/serverless";
import { describe, expect, test } from "vitest";
import { createNeonTools } from "../../../index.js";
import { sqlTypes } from "./connection.js";

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

describe("sqlTypes", () => {
	const { DATE, TIMESTAMP, TIMESTAMPTZ } = types.builtins;
	const TIMESTAMPTZ_ARRAY: number = 1185;
	const parse = (oid: number, text: string): unknown =>
		sqlTypes.getTypeParser(oid)(text);

	test("keeps the Postgres text for values a JavaScript Date cannot hold", () => {
		expect(parse(TIMESTAMPTZ, "294276-12-31 23:59:59+00")).toBe(
			"294276-12-31 23:59:59+00",
		);
		expect(parse(TIMESTAMP, "294276-12-31 23:59:59")).toBe(
			"294276-12-31 23:59:59",
		);
		expect(parse(DATE, "5874897-12-31")).toBe("5874897-12-31");
		expect(parse(TIMESTAMPTZ, "infinity")).toBe("infinity");
		expect(parse(DATE, "-infinity")).toBe("-infinity");
	});

	test("parses every other date and timestamp as the driver does", () => {
		for (const [oid, text] of [
			[TIMESTAMPTZ, "2026-11-25 10:00:00.123456+00"],
			[TIMESTAMP, "275760-09-12 00:00:00"],
			[TIMESTAMPTZ, "0001-01-01 00:00:00+00 BC"],
			[DATE, "2026-11-25"],
		] as const) {
			const value = parse(oid, text);
			expect(value).toBeInstanceOf(Date);
			expect(value).toEqual(types.getTypeParser(oid)(text));
		}
	});

	test("applies the same rule to each element of a nested array", () => {
		expect(
			parse(
				TIMESTAMPTZ_ARRAY,
				'{{"294276-12-31 23:59:59+00",NULL},{infinity,"2026-11-25 10:00:00+00"}}',
			),
		).toEqual([
			["294276-12-31 23:59:59+00", null],
			["infinity", new Date("2026-11-25T10:00:00.000Z")],
		]);
	});
});
