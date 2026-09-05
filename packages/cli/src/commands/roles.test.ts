import { describe, expect } from "vitest";

import { test } from "../test_utils/fixtures";

describe("roles", () => {
	test("list", async ({ testCliCommand }) => {
		await testCliCommand([
			"roles",
			"list",
			"--project-id",
			"test",
			"--branch",
			"test_branch",
		]);
	});

	test("create", async ({ testCliCommand }) => {
		await testCliCommand([
			"roles",
			"create",
			"--project-id",
			"test",
			"--branch",
			"test_branch",
			"--name",
			"test_role",
		]);
	});

	test("delete requires confirmation without --yes", async ({
		testCliCommand,
	}) => {
		await testCliCommand(
			[
				"roles",
				"delete",
				"test_role",
				"--project-id",
				"test",
				"--branch",
				"test_branch",
			],
			{
				code: 1,
				snapshot: false,
				stderr: "ERROR: Deleting a role requires confirmation. Re-run interactively or pass --yes.",
			},
		);
	});

	test("delete", async ({ testCliCommand }) => {
		await testCliCommand([
			"roles",
			"delete",
			"test_role",
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
				"roles",
				"delete",
				"test_role",
				"--project-id",
				"test",
				"--branch",
				"test_branch",
				"--yes",
			],
			{ output: "table", snapshot: false, stderr: "" },
		);
		expect(stdout).toBe("Deleted role test_role.\n");
	});
});
