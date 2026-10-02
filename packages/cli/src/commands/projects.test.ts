import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect } from "vitest";
import YAML from "yaml";

import { test } from "../test_utils/fixtures";
import { formatDuration } from "./projects";

const contextFile = (context: Record<string, string>) => {
	const path = join(mkdtempSync(join(tmpdir(), "neon-projects-")), ".neon");
	writeFileSync(path, JSON.stringify(context));
	return path;
};

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

			expect(stdout).not.toContain("never-expose-this-password");
			expect(stdout).not.toContain("connection_uri");
			expect(stdout).not.toContain("connection_parameters");

			if (output === "table") {
				expect(stdout).toContain("new-project-safe-output");
				return;
			}

			const parsed: unknown =
				output === "json" ? JSON.parse(stdout) : YAML.parse(stdout);
			expect(parsed).toEqual(
				expect.objectContaining({
					project: expect.objectContaining({
						id: "new-project-safe-output",
					}),
				}),
			);
			expect(parsed).not.toHaveProperty("connection_uris");
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

	test("list marks the linked project in the table", async ({
		testCliCommand,
	}) => {
		await testCliCommand(
			[
				"projects",
				"list",
				"--context-file",
				contextFile({ projectId: "adj-noun-12401747" }),
			],
			{ output: "table" },
		);
	});

	test("list marks a linked recoverable project", async ({
		testCliCommand,
	}) => {
		const { stdout } = await testCliCommand(
			[
				"projects",
				"list",
				"--recoverable-only",
				"--context-file",
				contextFile({ projectId: "deleted-project-123456" }),
			],
			{ output: "table", snapshot: false },
		);
		expect(stdout).toMatch(
			/deleted-project-123456\s+\[current\] Deleted_Project_1/,
		);
		expect(stdout).not.toMatch(/\[current\] Deleted_Project_2/);
	});

	test("list colors the marker in a color terminal", async ({
		testCliCommand,
	}) => {
		const { stdout } = await testCliCommand(
			[
				"projects",
				"list",
				"--context-file",
				contextFile({ projectId: "adj-noun-12401747" }),
			],
			{ output: "table", snapshot: false, env: { FORCE_COLOR: "1" } },
		);
		expect(stdout).toContain(
			"\u001b[32m[current]\u001b[39m Shared Project",
		);
	});

	test("list keeps JSON free of the marker", async ({ testCliCommand }) => {
		const linked = await testCliCommand(
			[
				"projects",
				"list",
				"--context-file",
				contextFile({ projectId: "adj-noun-12401747" }),
			],
			{ output: "json", snapshot: false },
		);
		const unlinked = await testCliCommand(["projects", "list"], {
			output: "json",
			snapshot: false,
		});
		expect(linked.stdout).toBe(unlinked.stdout);
	});

	test("list with the org from the context skips shared projects", async ({
		testCliCommand,
	}) => {
		const inherited = await testCliCommand(
			[
				"projects",
				"list",
				"--context-file",
				contextFile({ orgId: "org-2" }),
			],
			{ snapshot: false },
		);
		const explicit = await testCliCommand(
			["projects", "list", "--org-id", "org-2"],
			{ snapshot: false },
		);
		expect(inherited.stdout).toBe(explicit.stdout);
		expect(inherited.stdout).not.toContain("Shared Project");
	});

	test("get shows project details in the table", async ({
		testCliCommand,
	}) => {
		await testCliCommand(["projects", "get", "proj-details"], {
			output: "table",
		});
	});

	test("get shows a fixed compute size and zero retention", async ({
		testCliCommand,
	}) => {
		await testCliCommand(["projects", "get", "proj-fixed-cu"], {
			output: "table",
		});
	});

	test("get omits details the API did not return", async ({
		testCliCommand,
	}) => {
		await testCliCommand(["projects", "get", "test"], { output: "table" });
	});

	test("get keeps the full project in JSON", async ({ testCliCommand }) => {
		const { stdout } = await testCliCommand(
			["projects", "get", "proj-details"],
			{ output: "json", snapshot: false },
		);
		expect(JSON.parse(stdout)).toEqual(
			JSON.parse(
				readFileSync(
					"mocks/main/projects/proj-details/GET.json",
					"utf8",
				),
			).project,
		);
	});
});

describe("formatDuration", () => {
	test("uses the largest exact unit", () => {
		expect(formatDuration(604_800)).toBe("7 days");
		expect(formatDuration(86_400)).toBe("1 day");
		expect(formatDuration(7_200)).toBe("2 hours");
		expect(formatDuration(5_400)).toBe("90 minutes");
		expect(formatDuration(61)).toBe("61 seconds");
		expect(formatDuration(1)).toBe("1 second");
		expect(formatDuration(0)).toBe("0 seconds");
	});
});
