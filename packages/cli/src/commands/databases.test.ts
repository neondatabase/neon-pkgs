import { describe, expect } from "vitest";
import YAML from "yaml";

import { test } from "../test_utils/fixtures";

const missingDbMessage =
	'Database "nosuchdb" not found on branch test_branch; nothing to delete.';

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

	test("delete of a missing name reports not found and exits 1", async ({
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
			{ code: 1, snapshot: false, stderr: "" },
		);
		expect(YAML.parse(stdout)).toEqual({
			deleted: false,
			message: missingDbMessage,
		});
	});

	test("delete of a missing name prints ERROR in table mode", async ({
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
			{
				code: 1,
				output: "table",
				snapshot: false,
				stderr: `ERROR: ${missingDbMessage}`,
			},
		);
		expect(stdout).toBe("");
	});

	test("delete of a missing name emits json and exits 1", async ({
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
			{ code: 1, output: "json", snapshot: false, stderr: "" },
		);
		expect(JSON.parse(stdout)).toEqual({
			deleted: false,
			message: missingDbMessage,
		});
	});
});
