import { describe } from "vitest";

import { test } from "../test_utils/fixtures";

describe("operations", () => {
	test("list", async ({ testCliCommand }) => {
		await testCliCommand(["operations", "list", "--project-id", "test"]);
	});

	test("list (table) leads with action, status, branch, and duration, and ends with the id", async ({
		testCliCommand,
	}) => {
		await testCliCommand(
			["operations", "list", "--project-id", "ops-table"],
			{
				outputTable: true,
			},
		);
	});

	test("list (json) prints the operations as the API returned them", async ({
		testCliCommand,
	}) => {
		await testCliCommand(
			["operations", "list", "--project-id", "ops-table"],
			{
				output: "json",
			},
		);
	});

	test("list (table) with no operations says so", async ({
		testCliCommand,
	}) => {
		await testCliCommand(
			["operations", "list", "--project-id", "ops-empty"],
			{
				outputTable: true,
			},
		);
	});
});
