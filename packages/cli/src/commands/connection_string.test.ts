import { describe, expect } from "vitest";
import {
	forwardedPsqlArgs,
	NUMERIC_PSQL_ARGS,
	test,
} from "../test_utils/fixtures";

describe("connection_string", () => {
	test("reports a 200 response whose body is not valid JSON", async ({
		testCliCommand,
	}) => {
		const { stdout } = await testCliCommand(
			[
				"connection-string",
				"br-sunny-branch-123456",
				"--project-id",
				"test",
				"--role-name",
				"neondb_owner",
			],
			{
				mockDir: "unparseable-databases",
				snapshot: false,
				code: 1,
				stderr: expect.stringMatching(
					/ERROR: Could not read the Neon API response \(200 OK\) to \/projects\/test\/branches\/br-sunny-branch-123456\/databases: the body is not valid JSON/,
				),
			},
		);
		expect(stdout).toBe("");
	});

	test("picks neondb_owner over the Data API roles", async ({
		testCliCommand,
	}) => {
		const { stdout } = await testCliCommand(
			[
				"connection-string",
				"br-sunny-branch-123456",
				"--project-id",
				"test",
				"--database-name",
				"test_db",
			],
			{ mockDir: "data-api-roles", snapshot: false },
		);
		expect(stdout).toContain("postgresql://neondb_owner:test_pwd@");
	});

	test("picks the only app role when the owner has a custom name", async ({
		testCliCommand,
	}) => {
		const { stdout } = await testCliCommand(
			[
				"connection-string",
				"br-cloudy-branch-12345678",
				"--project-id",
				"test",
				"--database-name",
				"test_db",
			],
			{ mockDir: "data-api-roles", snapshot: false },
		);
		expect(stdout).toContain("postgresql://app_owner:test_pwd@");
	});

	test("asks for --role-name when more than one app role remains", async ({
		testCliCommand,
	}) => {
		await testCliCommand(
			[
				"connection-string",
				"br-main-branch-123456",
				"--project-id",
				"test",
				"--database-name",
				"test_db",
			],
			{
				mockDir: "data-api-roles",
				snapshot: false,
				code: 1,
				stderr: expect.stringContaining(
					"Multiple roles found for the branch, please provide one with the --role-name option: app_owner, app_reader, authenticator, anonymous, authenticated",
				),
			},
		);
	});

	test("connection_string", async ({ testCliCommand }) => {
		await testCliCommand([
			"connection-string",
			"test_branch",
			"--project-id",
			"test",
			"--database-name",
			"test_db",
			"--role-name",
			"test_role",
		]);
	});

	test("connection_string branch id", async ({ testCliCommand }) => {
		await testCliCommand([
			"connection-string",
			"br-sunny-branch-123456",
			"--project-id",
			"test",
			"--database-name",
			"test_db",
			"--role-name",
			"test_role",
		]);
	});

	test("connection_string branch id 8 digits", async ({ testCliCommand }) => {
		await testCliCommand([
			"connection-string",
			"br-cloudy-branch-12345678",
			"--project-id",
			"test",
			"--database-name",
			"test_db",
			"--role-name",
			"test_role",
		]);
	});

	test("connection_string pooled", async ({ testCliCommand }) => {
		await testCliCommand([
			"connection-string",
			"test_branch",
			"--project-id",
			"test",
			"--database-name",
			"test_db",
			"--role-name",
			"test_role",
			"--pooled",
		]);
	});

	test("connection_string prisma", async ({ testCliCommand }) => {
		await testCliCommand([
			"connection-string",
			"test_branch",
			"--project-id",
			"test",
			"--database-name",
			"test_db",
			"--role-name",
			"test_role",
			"--prisma",
		]);
	});

	test("connection_string prisma pooled", async ({ testCliCommand }) => {
		await testCliCommand([
			"connection-string",
			"test_branch",
			"--project-id",
			"test",
			"--database-name",
			"test_db",
			"--role-name",
			"test_role",
			"--prisma",
			"--pooled",
		]);
	});

	test("connection_string prisma pooled extended", async ({
		testCliCommand,
	}) => {
		await testCliCommand([
			"connection-string",
			"test_branch",
			"--project-id",
			"test",
			"--database-name",
			"test_db",
			"--role-name",
			"test_role",
			"--prisma",
			"--pooled",
			"--extended",
		]);
	});

	test("connection_string without any args should pass", async ({
		testCliCommand,
	}) => {
		await testCliCommand(["connection-string"], {
			mockDir: "single_project",
		});
	});

	test("connection_string with psql", async ({ testCliCommand }) => {
		await testCliCommand([
			"connection-string",
			"test_branch",
			"--project-id",
			"test",
			"--database-name",
			"test_db",
			"--role-name",
			"test_role",
			"--psql",
		]);
	});

	test("connection_string with psql and psql args", async ({
		testCliCommand,
	}) => {
		await testCliCommand([
			"connection-string",
			"test_branch",
			"--project-id",
			"test",
			"--database-name",
			"test_db",
			"--role-name",
			"test_role",
			"--psql",
			"--",
			"-c",
			"SELECT 1",
		]);
	});

	test("connection_string with psql forwards numeric-looking args as typed", async ({
		testCliCommand,
	}) => {
		const { stdout } = await testCliCommand(
			[
				"connection-string",
				"test_branch",
				"--project-id",
				"test",
				"--database-name",
				"test_db",
				"--role-name",
				"test_role",
				"--psql",
				"--",
				...NUMERIC_PSQL_ARGS,
			],
			{ snapshot: false },
		);
		expect(forwardedPsqlArgs(stdout)).toEqual(NUMERIC_PSQL_ARGS);
	});

	test("connection_string without ssl", async ({ testCliCommand }) => {
		await testCliCommand([
			"connection-string",
			"test_branch",
			"--project-id",
			"test",
			"--database-name",
			"test_db",
			"--role-name",
			"test_role",
			"--ssl",
			"omit",
		]);
	});

	test("connection_string with ssl verify full", async ({
		testCliCommand,
	}) => {
		await testCliCommand([
			"connection-string",
			"test_branch",
			"--project-id",
			"test",
			"--database-name",
			"test_db",
			"--role-name",
			"test_role",
			"--ssl",
			"verify-full",
		]);
	});

	test("connection_string with lsn", async ({ testCliCommand }) => {
		await testCliCommand([
			"connection-string",
			"test_branch@0/123456",
			"--project-id",
			"test",
			"--database-name",
			"test_db",
			"--role-name",
			"test_role",
		]);
	});

	test("connection_string with timestamp", async ({ testCliCommand }) => {
		await testCliCommand([
			"connection-string",
			"test_branch@2021-01-01T00:00:00Z",
			"--project-id",
			"test",
			"--database-name",
			"test_db",
			"--role-name",
			"test_role",
		]);
	});

	test("connection_string fails for non-existing database", async ({
		testCliCommand,
	}) => {
		await testCliCommand(
			[
				"connection-string",
				"test_branch",
				"--project-id",
				"test",
				"--database-name",
				"non_existing_db",
				"--role-name",
				"test_role",
			],
			{
				code: 1,
				stderr: expect.stringMatching(/Database not found/),
			},
		);
	});
});
