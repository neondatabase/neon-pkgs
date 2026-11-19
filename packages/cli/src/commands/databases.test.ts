import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect } from "vitest";

import { type RecordedRequest, test } from "../test_utils/fixtures";

const missingDbMessage =
	'Database "gone_db" not found on branch test_branch; nothing to delete.';

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

	test("create --name uses the branch from .neon", async ({
		testCliCommand,
	}) => {
		const dir = mkdtempSync(join(tmpdir(), "neon-databases-linked-"));
		const contextFile = join(dir, ".neon");
		writeFileSync(
			contextFile,
			JSON.stringify({ projectId: "test", branch: "test_branch" }),
		);
		const requests: RecordedRequest[] = [];
		try {
			await testCliCommand(
				[
					"databases",
					"create",
					"--name",
					"test_db",
					"--owner-name",
					"test_owner",
					"--context-file",
					contextFile,
				],
				{ snapshot: false, onRequest: (r) => requests.push(r) },
			);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
		expect(requests).toContainEqual(
			expect.objectContaining({
				method: "POST",
				path: "/projects/test/branches/br-sunny-branch-123456/databases",
			}),
		);
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

	test("create takes the name as an argument or as --name", async ({
		testCliCommand,
	}) => {
		for (const name of [
			["test_db"],
			["--name", "test_db"],
			["test_db", "--name", "test_db"],
		]) {
			const requests: RecordedRequest[] = [];
			await testCliCommand(
				[
					"databases",
					"create",
					...name,
					"--project-id",
					"test",
					"--branch",
					"test_branch",
					"--owner-name",
					"test_owner",
				],
				{ snapshot: false, onRequest: (r) => requests.push(r) },
			);
			expect(requests).toContainEqual({
				method: "POST",
				path: "/projects/test/branches/br-sunny-branch-123456/databases",
				body: {
					database: { name: "test_db", owner_name: "test_owner" },
				},
			});
		}
	});

	test("delete takes the name as an argument or as --name", async ({
		testCliCommand,
	}) => {
		for (const name of [
			["test_db"],
			["--name", "test_db"],
			["test_db", "--name", "test_db"],
		]) {
			const requests: string[] = [];
			await testCliCommand(
				[
					"databases",
					"delete",
					...name,
					"--project-id",
					"test",
					"--branch",
					"test_branch",
				],
				{
					snapshot: false,
					onRequest: (r) => requests.push(`${r.method} ${r.path}`),
				},
			);
			expect(requests).toContain(
				"DELETE /projects/test/branches/br-sunny-branch-123456/databases/test_db",
			);
		}
	});

	test("create and delete reject two different names before any request", async ({
		testCliCommand,
	}) => {
		for (const command of ["create", "delete"]) {
			const requests: string[] = [];
			const { stderr } = await testCliCommand(
				[
					"databases",
					command,
					"test_db",
					"--name",
					"other",
					"--project-id",
					"test",
					"--branch",
					"test_branch",
				],
				{
					code: 1,
					snapshot: false,
					onRequest: (r) => requests.push(r.path),
				},
			);
			expect(stderr).toContain(
				'ERROR: Two different names were given: "test_db" as an argument and "other" with --name. Pass one of them.',
			);
			expect(requests).toEqual([]);
		}
	});

	test("create and delete without a name fail before any request", async ({
		testCliCommand,
	}) => {
		for (const command of ["create", "delete"]) {
			const requests: string[] = [];
			const { stderr } = await testCliCommand(
				[
					"databases",
					command,
					"--project-id",
					"test",
					"--branch",
					"test_branch",
				],
				{
					code: 1,
					snapshot: false,
					onRequest: (r) => requests.push(r.path),
				},
			);
			expect(stderr).toContain("ERROR: Missing required argument: name");
			expect(requests).toEqual([]);
		}
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

	test("delete of a missing name reports it on stderr and exits 0", async ({
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
				{
					output,
					snapshot: false,
					stdout: "",
					stderr: missingDbMessage,
				},
			);
		}
	});
});
