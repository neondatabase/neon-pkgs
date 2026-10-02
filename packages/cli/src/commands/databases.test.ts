import { readFileSync } from "node:fs";
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

	test("delete", async ({ testCliCommand }) => {
		await testCliCommand([
			"databases",
			"delete",
			"test_db",
			"--project-id",
			"test",
			"--branch",
			"test_branch",
		]);
	});

	test("list names the resolved branch in the table", async ({
		testCliCommand,
	}) => {
		await testCliCommand(
			[
				"databases",
				"list",
				"--project-id",
				"test",
				"--branch",
				"test_branch",
			],
			{ output: "table" },
		);
	});

	test("list names the default branch, even when it has no databases", async ({
		testCliCommand,
	}) => {
		await testCliCommand(["databases", "list", "--project-id", "test"], {
			output: "table",
		});
	});

	test("list shows an explicit branch id as given", async ({
		testCliCommand,
	}) => {
		await testCliCommand(
			[
				"databases",
				"list",
				"--project-id",
				"test",
				"--branch",
				"br-sunny-branch-123456",
			],
			{ output: "table" },
		);
	});

	test("list keeps JSON as the bare database array", async ({
		testCliCommand,
	}) => {
		const { stdout } = await testCliCommand(
			[
				"databases",
				"list",
				"--project-id",
				"test",
				"--branch",
				"test_branch",
			],
			{ output: "json", snapshot: false },
		);
		expect(JSON.parse(stdout)).toEqual(
			JSON.parse(
				readFileSync(
					"mocks/main/projects/test/branches/br-sunny-branch-123456/databases/GET.json",
					"utf8",
				),
			).databases,
		);
	});

	test("create names the branch in the table", async ({ testCliCommand }) => {
		await testCliCommand(
			[
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
			],
			{ output: "table" },
		);
	});

	test("delete names the branch in the table", async ({ testCliCommand }) => {
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
			{ output: "table" },
		);
	});

	test("delete of a database that is already gone prints nothing", async ({
		testCliCommand,
	}) => {
		for (const output of ["table", "json", "yaml"] as const) {
			await testCliCommand(
				[
					"databases",
					"delete",
					"gone_db",
					"--project-id",
					"test",
					"--branch",
					"test_branch",
				],
				{ output, snapshot: false, stdout: "" },
			);
		}
	});
});
