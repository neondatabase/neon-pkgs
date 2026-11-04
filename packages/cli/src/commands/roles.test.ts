import { readFileSync } from "node:fs";
import { describe, expect } from "vitest";

import { test } from "../test_utils/fixtures";

const missingRoleMessage =
	'Role "gone_role" not found on branch test_branch; nothing to delete.';

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

	test("get", async ({ testCliCommand }) => {
		const requests: string[] = [];
		await testCliCommand(
			[
				"roles",
				"get",
				"test_role",
				"--project-id",
				"test",
				"--branch",
				"br-sunny-branch-123456",
			],
			{
				output: "table",
				onRequest: (r) => requests.push(`${r.method} ${r.path}`),
			},
		);
		expect(requests).toEqual([
			"GET /projects/test/branches/br-sunny-branch-123456/roles/test_role",
		]);
	});

	test("get on an unknown role exits 1", async ({ testCliCommand }) => {
		await testCliCommand(
			[
				"roles",
				"get",
				"missing_role",
				"--project-id",
				"test",
				"--branch",
				"br-sunny-branch-123456",
			],
			{ code: 1, snapshot: false, stderr: "ERROR: Not Found" },
		);
	});

	test("reset-password waits for the operation and prints the new password", async ({
		testCliCommand,
	}) => {
		const requests: string[] = [];
		await testCliCommand(
			[
				"roles",
				"reset-password",
				"test_role",
				"--project-id",
				"test",
				"--branch",
				"test_branch",
			],
			{
				output: "table",
				onRequest: (r) => requests.push(`${r.method} ${r.path}`),
			},
		);
		expect(requests).toContain(
			"POST /projects/test/branches/br-sunny-branch-123456/roles/test_role/reset_password",
		);
		expect(requests.at(-1)).toBe(
			"GET /projects/test/operations/op-role-reset",
		);
	});

	test("reset-password --no-wait does not poll", async ({
		testCliCommand,
	}) => {
		const requests: string[] = [];
		const { stdout } = await testCliCommand(
			[
				"roles",
				"reset-password",
				"test_role",
				"--project-id",
				"test",
				"--branch",
				"br-sunny-branch-123456",
				"--no-wait",
			],
			{
				output: "json",
				snapshot: false,
				onRequest: (r) => requests.push(`${r.method} ${r.path}`),
			},
		);
		expect(requests).toEqual([
			"POST /projects/test/branches/br-sunny-branch-123456/roles/test_role/reset_password",
		]);
		expect(JSON.parse(stdout)).toMatchObject({
			name: "test_role",
			password: "new_test_pwd",
		});
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

	test("list names the resolved branch in the table", async ({
		testCliCommand,
	}) => {
		await testCliCommand(
			[
				"roles",
				"list",
				"--project-id",
				"test",
				"--branch",
				"test_branch",
			],
			{ output: "table" },
		);
	});

	test("list names the default branch, even when it has no roles", async ({
		testCliCommand,
	}) => {
		await testCliCommand(["roles", "list", "--project-id", "test"], {
			output: "table",
		});
	});

	test("list shows an explicit branch id as given", async ({
		testCliCommand,
	}) => {
		await testCliCommand(
			[
				"roles",
				"list",
				"--project-id",
				"test",
				"--branch",
				"br-sunny-branch-123456",
			],
			{ output: "table" },
		);
	});

	test("list keeps JSON as the bare role array", async ({
		testCliCommand,
	}) => {
		const { stdout } = await testCliCommand(
			[
				"roles",
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
					"mocks/main/projects/test/branches/br-sunny-branch-123456/roles/GET.json",
					"utf8",
				),
			).roles,
		);
	});

	test("create names the branch in the table", async ({ testCliCommand }) => {
		await testCliCommand(
			[
				"roles",
				"create",
				"--project-id",
				"test",
				"--branch",
				"test_branch",
				"--name",
				"test_role",
			],
			{ output: "table" },
		);
	});

	test("create rejects --database without a scoped --access", async ({
		testCliCommand,
	}) => {
		const requests: string[] = [];
		const { stderr } = await testCliCommand(
			[
				"roles",
				"create",
				"--project-id",
				"test",
				"--branch",
				"test_branch",
				"--name",
				"test_role",
				"--database",
				"neondb",
			],
			{
				code: 1,
				snapshot: false,
				onRequest: (request) => requests.push(request.path),
			},
		);
		expect(stderr).toContain(
			"--database and --schema need --access read_only or --access read_write",
		);
		expect(requests).toEqual([]);
	});

	test("delete names the branch in the table", async ({ testCliCommand }) => {
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
			{ output: "table" },
		);
	});

	test("delete of a missing name reports it on stderr and exits 0", async ({
		testCliCommand,
	}) => {
		for (const output of ["table", "json", "yaml"] as const) {
			await testCliCommand(
				[
					"roles",
					"delete",
					"gone_role",
					"--project-id",
					"test",
					"--branch",
					"test_branch",
				],
				{
					output,
					snapshot: false,
					stdout: "",
					stderr: missingRoleMessage,
				},
			);
		}
	});

	for (const flag of ["--no-login", "--no-login=true"]) {
		test(`create ${flag} sends no_login and shows no password`, async ({
			testCliCommand,
		}) => {
			const { stdout } = await testCliCommand(
				[
					"roles",
					"create",
					"--project-id",
					"test",
					"--branch",
					"test_branch",
					"--name",
					"no_login_role",
					flag,
				],
				{ output: "table", snapshot: false },
			);
			expect(stdout).toContain("Role created on test_branch");
			expect(stdout).not.toContain("Password");
		});
	}
});
