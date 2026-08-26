import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect } from "vitest";

import { test } from "../test_utils/fixtures";

describe("projects", () => {
	test("list", async ({ testCliCommand }) => {
		await testCliCommand(["projects", "list"]);
	});

	test("list with org id", async ({ testCliCommand }) => {
		await testCliCommand(["projects", "list", "--org-id", "org-2"]);
	});

	test("list recoverable projects", async ({ testCliCommand }) => {
		await testCliCommand(["projects", "list", "--recoverable-only"]);
	});

	test("create", async ({ testCliCommand }) => {
		await testCliCommand(["projects", "create", "--name", "test_project"]);
	});

	for (const output of ["table", "json", "yaml"] as const) {
		test(`create --no-secrets/${output}`, async ({ testCliCommand }) => {
			const { stdout } = await testCliCommand(
				[
					"projects",
					"create",
					"--name",
					"test_project_no_secrets",
					"--no-secrets",
				],
				{ output, snapshot: false },
			);

			expect(stdout).toContain("new-project-safe-output");
			expect(stdout).not.toContain("never-expose-this-password");
			expect(stdout).not.toContain("connection_uri");
			expect(stdout).not.toContain("connection_parameters");
		});
	}

	test("create with hipaa flag", async ({ testCliCommand }) => {
		await testCliCommand([
			"projects",
			"create",
			"--name",
			"test_project",
			"--hipaa",
		]);
	});

	test("create with org id", async ({ testCliCommand }) => {
		await testCliCommand([
			"projects",
			"create",
			"--name",
			"test_project",
			"--org-id",
			"org-2",
		]);
	});

	test("create with database and role", async ({ testCliCommand }) => {
		await testCliCommand([
			"projects",
			"create",
			"--name",
			"test_project",
			"--database",
			"test_db",
			"--role",
			"test_role",
		]);
	});

	test("create with PostgreSQL version", async ({ testCliCommand }) => {
		await testCliCommand([
			"projects",
			"create",
			"--name",
			"test_project_with_pg_version",
			"--pg-version",
			"18",
		]);
	});

	test("create and connect with psql", async ({ testCliCommand }) => {
		await testCliCommand([
			"projects",
			"create",
			"--name",
			"test_project",
			"--psql",
		]);
	});

	test("create and connect with psql and psql args", async ({
		testCliCommand,
	}) => {
		await testCliCommand([
			"projects",
			"create",
			"--name",
			"test_project",
			"--psql",
			"--",
			"-c",
			"SELECT 1",
		]);
	});

	test("create project with setting the context", async ({
		testCliCommand,
	}) => {
		const CONTEXT_FILE = join(
			tmpdir(),
			`neon_project_create_ctx_${Date.now()}`,
		);
		await testCliCommand([
			"projects",
			"create",
			"--name",
			"test_project",
			"--context-file",
			CONTEXT_FILE,
			"--set-context",
		]);
		expect(readFileSync(CONTEXT_FILE, "utf-8")).toContain(
			"new-project-123456",
		);
		rmSync(CONTEXT_FILE);
	});

	test("create project with default fixed size CU", async ({
		testCliCommand,
	}) => {
		await testCliCommand([
			"projects",
			"create",
			"--name",
			"test_project_with_fixed_cu",
			"--cu",
			"2",
		]);
	});

	test("create project with default autoscaled CU", async ({
		testCliCommand,
	}) => {
		await testCliCommand([
			"projects",
			"create",
			"--name",
			"test_project_with_autoscaling",
			"--cu",
			"0.5-2",
		]);
	});

	test("delete", async ({ testCliCommand }) => {
		await testCliCommand(["projects", "delete", "test"]);
	});

	test("recover deleted project", async ({ testCliCommand }) => {
		await testCliCommand(["projects", "recover", "test"]);
	});

	test("update name", async ({ testCliCommand }) => {
		await testCliCommand([
			"projects",
			"update",
			"test",
			"--name",
			"test_project_new_name",
		]);
	});

	test("update hipaa flag", async ({ testCliCommand }) => {
		await testCliCommand(["projects", "update", "test", "--hipaa"]);
	});

	test("update enables logical replication with confirmation bypass", async ({
		testCliCommand,
	}) => {
		await testCliCommand([
			"projects",
			"update",
			"test",
			"--enable-logical-replication",
			"--yes",
		]);
	});

	test("update requires confirmation to enable logical replication", async ({
		testCliCommand,
	}) => {
		await testCliCommand(
			["projects", "update", "test", "--enable-logical-replication"],
			{
				code: 1,
				stderr: "ERROR: Enabling logical replication requires confirmation. Re-run interactively or pass --yes.",
			},
		);
	});

	test("update rejects disabling logical replication", async ({
		testCliCommand,
	}) => {
		await testCliCommand(
			[
				"projects",
				"update",
				"test",
				"--enable-logical-replication=false",
			],
			{
				code: 1,
				stderr: "ERROR: Logical replication cannot be disabled once it has been enabled.",
			},
		);
	});

	test("update project with default fixed size CU", async ({
		testCliCommand,
	}) => {
		await testCliCommand([
			"projects",
			"update",
			"test_project_with_fixed_cu",
			"--cu",
			"2",
		]);
	});

	test("update project with default autoscaled CU", async ({
		testCliCommand,
	}) => {
		await testCliCommand([
			"projects",
			"update",
			"test_project_with_autoscaling",
			"--cu",
			"0.5-2",
		]);
	});

	test("get", async ({ testCliCommand }) => {
		await testCliCommand(["projects", "get", "test"]);
	});
});
