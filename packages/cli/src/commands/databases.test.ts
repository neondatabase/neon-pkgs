import { describe, expect } from "vitest";

import { test } from "../test_utils/fixtures";

describe("databases", () => {
	test("list", async ({ testCliCommand }) => {
		await testCliCommand([
			"databases",
			"list",
			"--project-id",
			"test",
			"--branch",
			"test_branch",
		]);
	});

	test("create", async ({ testCliCommand }) => {
		await testCliCommand([
			"databases",
			"create",
			"--project-id",
			"test",
			"--branch",
			"test_branch",
			"--name",
			"test_db",
			"--owner-name",
			"test_owner",
		]);
	});

	test("delete requires confirmation without --yes", async ({
		testCliCommand,
	}) => {
		await testCliCommand(
			[
				"databases",
				"delete",
				"test_db",
				"--project-id",
				"test",
				"--branch",
				"test_branch",
			],
			{
				code: 1,
				snapshot: false,
				output: "table",
				stderr: "ERROR: Deleting a database requires confirmation. Re-run interactively or pass --yes.",
			},
		);
	});

	test("delete", async ({ testCliCommand }) => {
		await testCliCommand([
			"databases",
			"delete",
			"test_db",
			"--project-id",
			"test",
			"--branch",
			"test_branch",
			"--yes",
		]);
	});

	test("delete --yes prints Deleted in table mode", async ({
		testCliCommand,
	}) => {
		const { stdout } = await testCliCommand(
			[
				"databases",
				"delete",
				"test_db",
				"--project-id",
				"test",
				"--branch",
				"test_branch",
				"--yes",
			],
			{ output: "table", snapshot: false, stderr: "" },
		);
		expect(stdout).toBe("Deleted database test_db.\n");
	});
});
