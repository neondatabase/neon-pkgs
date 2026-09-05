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

	test("delete", async ({ testCliCommand }) => {
		await testCliCommand([
			"roles",
			"delete",
			"test_role",
			"--project-id",
			"test",
			"--branch",
			"test_branch",
		]);
	});

	test("delete of a missing name reports not found and exits 1", async ({
		testCliCommand,
	}) => {
		const { stdout } = await testCliCommand(
			[
				"roles",
				"delete",
				"nosuchrole",
				"--project-id",
				"test",
				"--branch",
				"test_branch",
			],
			{ code: 1, snapshot: false, stderr: "" },
		);
		expect(stdout).toContain(
			'Role "nosuchrole" not found on branch test_branch; nothing to delete.',
		);
	});

	test("delete of a missing name prints the line in table mode", async ({
		testCliCommand,
	}) => {
		const { stdout } = await testCliCommand(
			[
				"roles",
				"delete",
				"nosuchrole",
				"--project-id",
				"test",
				"--branch",
				"test_branch",
			],
			{ code: 1, output: "table", snapshot: false, stderr: "" },
		);
		expect(stdout).toBe(
			'Role "nosuchrole" not found on branch test_branch; nothing to delete.\n',
		);
	});

	test("delete of a missing name emits json and exits 1", async ({
		testCliCommand,
	}) => {
		const { stdout } = await testCliCommand(
			[
				"roles",
				"delete",
				"nosuchrole",
				"--project-id",
				"test",
				"--branch",
				"test_branch",
			],
			{ code: 1, output: "json", snapshot: false, stderr: "" },
		);
		expect(JSON.parse(stdout)).toEqual({
			deleted: false,
			message:
				'Role "nosuchrole" not found on branch test_branch; nothing to delete.',
		});
		expect(stdout.endsWith("}")).toBe(true);
	});
});
