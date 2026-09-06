import { describe, expect, test } from "vitest";
import { createNeonTool } from "./index.js";
import { publishedId } from "./lib/ergonomic/bind.js";
import { toolIds } from "./lib/ergonomic/ids.js";

describe("publishedId", () => {
	test("resource first, then the last path segment", () => {
		expect(publishedId("projects.list")).toBe("projects_list");
		expect(publishedId("projects.createAndConnect")).toBe(
			"projects_create_and_connect",
		);
		expect(publishedId("branches.createAndConnect")).toBe(
			"branches_create_and_connect",
		);
		expect(publishedId("postgres.roles.resetPassword")).toBe(
			"postgres_roles_reset_password",
		);
		expect(publishedId("logs.query")).toBe("logs_query");
		expect(publishedId("user.me")).toBe("user_me");
		expect(publishedId("regions.list")).toBe("regions_list");
		expect(publishedId("functions.customDomains.list")).toBe(
			"functions_custom_domains_list",
		);
		expect(publishedId("functions.customDomains.register")).toBe(
			"functions_custom_domains_register",
		);
		expect(publishedId("functions.customDomains.delete")).toBe(
			"functions_custom_domains_delete",
		);
	});

	test("every catalog tool publishes publishedId(selector)", () => {
		for (const id of toolIds) {
			expect(createNeonTool(id, { apiKey: "test-key" }).id).toBe(
				publishedId(id),
			);
		}
	});
});
