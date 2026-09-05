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

	test("delete of a missing name reports not found", async ({
		testCliCommand,
	}) => {
		const { stdout } = await testCliCommand(
			[
				"databases",
				"delete",
				"nosuchdb",
				"--project-id",
				"test",
				"--branch",
				"test_branch",
			],
			{ snapshot: false, stderr: "" },
		);
		expect(stdout).toContain(
			'Database "nosuchdb" not found on branch test_branch; nothing to delete.',
		);
	});

	test("delete of a missing name prints the line in table mode", async ({
		testCliCommand,
	}) => {
		const { stdout } = await testCliCommand(
			[
				"databases",
				"delete",
				"nosuchdb",
				"--project-id",
				"test",
				"--branch",
				"test_branch",
			],
			{ output: "table", snapshot: false, stderr: "" },
		);
		expect(stdout).toBe(
			'Database "nosuchdb" not found on branch test_branch; nothing to delete.\n',
		);
	});

	test("delete of a missing name emits json", async ({ testCliCommand }) => {
		const { stdout } = await testCliCommand(
			[
				"databases",
				"delete",
				"nosuchdb",
				"--project-id",
				"test",
				"--branch",
				"test_branch",
			],
			{ output: "json", snapshot: false, stderr: "" },
		);
		expect(JSON.parse(stdout)).toEqual({
			message:
				'Database "nosuchdb" not found on branch test_branch; nothing to delete.',
		});
		expect(stdout.endsWith("}")).toBe(true);
	});
});
