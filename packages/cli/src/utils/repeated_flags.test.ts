import { describe, expect } from "vitest";
import { test } from "../test_utils/fixtures";

const repeated = (flag: string) =>
	`ERROR: --${flag} was given more than once. Pass it at most once.`;

describe("a single-value flag given more than once", () => {
	test("is rejected when the values differ", async ({ testCliCommand }) => {
		await testCliCommand(
			[
				"branches",
				"create",
				"--project-id",
				"test",
				"--parent",
				"a",
				"--parent",
				"b",
			],
			{ code: 1, snapshot: false, stderr: repeated("parent") },
		);
	});

	test("is rejected for a global flag", async ({ testCliCommand }) => {
		await testCliCommand(
			[
				"connection-string",
				"--project-id",
				"test",
				"--branch",
				"a",
				"--branch",
				"b",
			],
			{ code: 1, snapshot: false, stderr: repeated("branch") },
		);
	});

	test("is rejected for a number flag", async ({ testCliCommand }) => {
		await testCliCommand(
			[
				"branches",
				"create",
				"--project-id",
				"test",
				"--suspend-timeout",
				"1",
				"--suspend-timeout",
				"2",
			],
			{ code: 1, snapshot: false, stderr: repeated("suspend-timeout") },
		);
	});

	test("is rejected across an alias and its long form", async ({
		testCliCommand,
	}) => {
		await testCliCommand(
			["projects", "list", "--output", "yaml", "-o", "json"],
			{ code: 1, snapshot: false, stderr: repeated("output") },
		);
	});

	test("is rejected for an untyped global flag", async ({
		testCliCommand,
	}) => {
		// The fixture passes `--api-host` pointing at its mock server.
		await testCliCommand(
			["projects", "list", "--api-host", "http://localhost:1"],
			{ code: 1, snapshot: false, stderr: repeated("api-host") },
		);
	});

	test("is rejected before the API key is resolved", async ({
		testCliCommand,
	}) => {
		await testCliCommand(
			[
				"projects",
				"list",
				"--api-key",
				"first-key",
				"--api-key",
				"second-key",
			],
			{
				apiKey: false,
				code: 1,
				snapshot: false,
				stderr: repeated("api-key"),
				env: { NEON_API_KEY: "env-key" },
			},
		);
	});

	test("is accepted when every value is the same", async ({
		testCliCommand,
	}) => {
		const { stdout } = await testCliCommand(
			["projects", "list", "-o", "json", "--output", "json"],
			{ snapshot: false },
		);
		expect(JSON.parse(stdout)).toHaveProperty("projects");
	});
});
