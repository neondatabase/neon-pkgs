import { describe, expect, test } from "vitest";
import { createNeonTool } from "./index.js";
import { publishedId } from "./lib/ergonomic/bind.js";
import { toolIds } from "./lib/ergonomic/ids.js";

describe("publishedId", () => {
	test("moves the last path segment in front", () => {
		expect(publishedId("projects.list")).toBe("list_projects");
		expect(publishedId("projects.createAndConnect")).toBe(
			"create_and_connect_projects",
		);
		expect(publishedId("branches.createWithCompute")).toBe(
			"create_with_compute_branches",
		);
		expect(publishedId("postgres.roles.resetPassword")).toBe(
			"reset_password_postgres_roles",
		);
		expect(publishedId("logs.query")).toBe("query_logs");
		expect(publishedId("user.me")).toBe("me_user");
		expect(publishedId("regions.list")).toBe("list_regions");
	});

	test("every catalog tool publishes publishedId(selector)", () => {
		for (const id of toolIds) {
			expect(createNeonTool(id, { apiKey: "test-key" }).id).toBe(
				publishedId(id),
			);
		}
	});
});
