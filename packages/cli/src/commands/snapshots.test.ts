import { describe, expect } from "vitest";

import { test } from "../test_utils/fixtures";

describe("snapshots", () => {
	/* list */

	test("list/yaml", async ({ testCliCommand }) => {
		await testCliCommand(["snapshots", "list", "--project-id", "test"]);
	});

	test("list/table output", async ({ testCliCommand }) => {
		await testCliCommand(["snapshots", "list", "--project-id", "test"], {
			outputTable: true,
		});
	});

	test("snapshot alias works", async ({ testCliCommand }) => {
		await testCliCommand(["snapshot", "list", "--project-id", "test"]);
	});

	/* get */

	test("get by id", async ({ testCliCommand }) => {
		await testCliCommand([
			"snapshots",
			"get",
			"snap-first-snapshot-123456",
			"--project-id",
			"test",
		]);
	});

	test("get by name", async ({ testCliCommand }) => {
		await testCliCommand([
			"snapshots",
			"get",
			"pre-migration",
			"--project-id",
			"test",
		]);
	});

	test("get by slug", async ({ testCliCommand }) => {
		await testCliCommand([
			"snapshots",
			"get",
			"nightly-backup",
			"--project-id",
			"test",
		]);
	});

	test("get by unique name wins over another snapshot's slug", async ({
		testCliCommand,
	}) => {
		const { stdout } = await testCliCommand([
			"snapshots",
			"get",
			"pre-migration",
			"--project-id",
			"test",
		]);
		expect(stdout).toContain("snap-second-snapshot-123456");
		expect(stdout).not.toContain("snap-third-snapshot-123456");
	});

	test("get by exact id wins over another snapshot's slug", async ({
		testCliCommand,
	}) => {
		const { stdout } = await testCliCommand([
			"snapshots",
			"get",
			"snap-first-snapshot-123456",
			"--project-id",
			"test",
		]);
		expect(stdout).toContain("name: nightly");
	});

	test("get by a name with spaces and uppercase", async ({
		testCliCommand,
	}) => {
		await testCliCommand([
			"snapshots",
			"get",
			"Before Migration",
			"--project-id",
			"test",
		]);
	});

	test("get not found errors", async ({ testCliCommand }) => {
		const { stderr } = await testCliCommand(
			["snapshots", "get", "does-not-exist", "--project-id", "test"],
			{
				code: 1,
				stderr: expect.stringContaining(
					'Snapshot "does-not-exist" not found',
				),
			},
		);
		expect(stderr).toContain("slug: nightly-backup");
		expect(stderr).toContain("pre-migration (snap-second-snapshot-123456)");
	});

	/* create */

	test("create from default branch", async ({ testCliCommand }) => {
		await testCliCommand(["snapshots", "create", "--project-id", "test"]);
	});

	test("create with name", async ({ testCliCommand }) => {
		await testCliCommand([
			"snapshots",
			"create",
			"--project-id",
			"test",
			"--branch",
			"main",
			"--name",
			"pre-migration",
		]);
	});

	test("create with name and slug", async ({ testCliCommand }) => {
		const { stdout } = await testCliCommand([
			"snapshots",
			"create",
			"--project-id",
			"test",
			"--branch",
			"main",
			"--name",
			"Before migration",
			"--slug",
			"before-migration",
		]);
		expect(stdout).toContain("slug: before-migration");
		expect(stdout).toContain("name: Before migration");
	});

	test("create accepts a single-letter slug", async ({ testCliCommand }) => {
		const { stdout } = await testCliCommand([
			"snapshots",
			"create",
			"--project-id",
			"test",
			"--slug",
			"a",
		]);
		expect(stdout).toContain("slug: a");
	});

	test("create rejects an invalid slug", async ({ testCliCommand }) => {
		await testCliCommand(
			["snapshots", "create", "--project-id", "test", "--slug", "Before"],
			{
				code: 1,
				stderr: expect.stringContaining(
					'Invalid --slug value: "Before"',
				),
			},
		);
	});

	test("create rejects a trailing-hyphen slug", async ({
		testCliCommand,
	}) => {
		await testCliCommand(
			[
				"snapshots",
				"create",
				"--project-id",
				"test",
				"--slug",
				"before-",
			],
			{
				code: 1,
				stderr: expect.stringContaining("Invalid --slug value"),
			},
		);
	});

	test("create at a timestamp", async ({ testCliCommand }) => {
		await testCliCommand([
			"snapshots",
			"create",
			"--project-id",
			"test",
			"--branch",
			"main",
			"--timestamp",
			"2021-01-01T00:00:00Z",
		]);
	});

	test("create at an lsn with expiration", async ({ testCliCommand }) => {
		await testCliCommand([
			"snapshots",
			"create",
			"--project-id",
			"test",
			"--branch",
			"main",
			"--lsn",
			"0/1F3C8A0",
			"--expires-at",
			"2025-12-31T23:59:59Z",
		]);
	});

	test("create rejects both timestamp and lsn", async ({
		testCliCommand,
	}) => {
		await testCliCommand(
			[
				"snapshots",
				"create",
				"--project-id",
				"test",
				"--timestamp",
				"2021-01-01T00:00:00Z",
				"--lsn",
				"0/1F3C8A0",
			],
			{ code: 1 },
		);
	});

	test("create rejects an invalid lsn", async ({ testCliCommand }) => {
		await testCliCommand(
			[
				"snapshots",
				"create",
				"--project-id",
				"test",
				"--lsn",
				"not-an-lsn",
			],
			{
				code: 1,
				stderr: expect.stringContaining("Invalid --lsn value"),
			},
		);
	});

	/* update */

	test("update name", async ({ testCliCommand }) => {
		await testCliCommand([
			"snapshots",
			"update",
			"snap-first-snapshot-123456",
			"--project-id",
			"test",
			"--name",
			"renamed",
		]);
	});

	test("update by unique name", async ({ testCliCommand }) => {
		const { stdout } = await testCliCommand([
			"snapshots",
			"update",
			"nightly",
			"--project-id",
			"test",
			"--name",
			"renamed",
		]);
		expect(stdout).toContain("id: snap-first-snapshot-123456");
	});

	test("update by slug", async ({ testCliCommand }) => {
		const { stdout } = await testCliCommand([
			"snapshots",
			"update",
			"nightly-backup",
			"--project-id",
			"test",
			"--name",
			"renamed",
		]);
		expect(stdout).toContain("id: snap-first-snapshot-123456");
	});

	test("update expiration", async ({ testCliCommand }) => {
		await testCliCommand([
			"snapshots",
			"update",
			"snap-first-snapshot-123456",
			"--project-id",
			"test",
			"--expires-at",
			"2030-01-01T00:00:00Z",
		]);
	});

	test("update clear expiration", async ({ testCliCommand }) => {
		await testCliCommand([
			"snapshots",
			"update",
			"snap-first-snapshot-123456",
			"--project-id",
			"test",
			"--clear-expiration",
		]);
	});

	test("update with nothing to change errors", async ({ testCliCommand }) => {
		await testCliCommand(
			[
				"snapshots",
				"update",
				"snap-first-snapshot-123456",
				"--project-id",
				"test",
			],
			{
				code: 1,
				stderr: expect.stringContaining("Nothing to update"),
			},
		);
	});

	test("update rejects expires-at with clear-expiration", async ({
		testCliCommand,
	}) => {
		await testCliCommand(
			[
				"snapshots",
				"update",
				"snap-first-snapshot-123456",
				"--project-id",
				"test",
				"--expires-at",
				"2030-01-01T00:00:00Z",
				"--clear-expiration",
			],
			{ code: 1 },
		);
	});

	/* delete */

	test("delete by id", async ({ testCliCommand }) => {
		await testCliCommand([
			"snapshots",
			"delete",
			"snap-first-snapshot-123456",
			"--project-id",
			"test",
		]);
	});

	test("delete by name", async ({ testCliCommand }) => {
		await testCliCommand([
			"snapshots",
			"delete",
			"nightly",
			"--project-id",
			"test",
		]);
	});

	test("delete by slug", async ({ testCliCommand }) => {
		const { stdout } = await testCliCommand([
			"snapshots",
			"delete",
			"nightly-backup",
			"--project-id",
			"test",
		]);
		expect(stdout).toContain("id: snap-first-snapshot-123456");
	});

	/* restore */

	test("restore to a new branch", async ({ testCliCommand }) => {
		await testCliCommand([
			"snapshots",
			"restore",
			"snap-first-snapshot-123456",
			"--project-id",
			"test",
			"--name",
			"recovered",
		]);
	});

	test("restore by unique name", async ({ testCliCommand }) => {
		await testCliCommand([
			"snapshots",
			"restore",
			"nightly",
			"--project-id",
			"test",
			"--name",
			"recovered",
		]);
	});

	test("restore by slug", async ({ testCliCommand }) => {
		await testCliCommand([
			"snapshots",
			"restore",
			"nightly-backup",
			"--project-id",
			"test",
			"--name",
			"recovered",
		]);
	});

	test("restore onto a target branch and finalize", async ({
		testCliCommand,
	}) => {
		await testCliCommand([
			"snapshots",
			"restore",
			"snap-first-snapshot-123456",
			"--project-id",
			"test",
			"--target-branch",
			"main",
			"--finalize",
		]);
	});

	/* finalize */

	test("finalize a restored branch", async ({ testCliCommand }) => {
		await testCliCommand([
			"snapshots",
			"finalize",
			"br-restored-branch-123456",
			"--project-id",
			"test",
		]);
	});

	/* schedule */

	test("schedule get", async ({ testCliCommand }) => {
		await testCliCommand([
			"snapshots",
			"schedule",
			"get",
			"--project-id",
			"test",
			"--branch",
			"main",
		]);
	});

	test("schedule set from flags", async ({ testCliCommand }) => {
		await testCliCommand([
			"snapshots",
			"schedule",
			"set",
			"--project-id",
			"test",
			"--branch",
			"main",
			"--frequency",
			"daily",
			"--hour",
			"3",
			"--retention",
			"604800",
		]);
	});

	test("schedule set from json", async ({ testCliCommand }) => {
		await testCliCommand([
			"snapshots",
			"schedule",
			"set",
			"--project-id",
			"test",
			"--branch",
			"main",
			"--schedule",
			'[{"frequency":"weekly","day":1,"hour":2},{"frequency":"daily","hour":3}]',
		]);
	});

	test("schedule set from json rejects an unsupported frequency", async ({
		testCliCommand,
	}) => {
		await testCliCommand(
			[
				"snapshots",
				"schedule",
				"set",
				"--project-id",
				"test",
				"--branch",
				"main",
				"--schedule",
				'[{"frequency":"hourly"}]',
			],
			{
				code: 1,
				stderr: expect.stringContaining('unsupported "frequency"'),
			},
		);
	});

	test("schedule set with nothing errors", async ({ testCliCommand }) => {
		await testCliCommand(
			[
				"snapshots",
				"schedule",
				"set",
				"--project-id",
				"test",
				"--branch",
				"main",
			],
			{
				code: 1,
				stderr: expect.stringContaining("Provide --frequency"),
			},
		);
	});

	test("schedule set rejects invalid json", async ({ testCliCommand }) => {
		await testCliCommand(
			[
				"snapshots",
				"schedule",
				"set",
				"--project-id",
				"test",
				"--branch",
				"main",
				"--schedule",
				"{not json}",
			],
			{
				code: 1,
				stderr: expect.stringContaining("valid JSON"),
			},
		);
	});

	test("create --help documents --slug", async ({ testCliCommand }) => {
		const { stdout } = await testCliCommand(
			["snapshots", "create", "--help"],
			{ snapshot: false },
		);
		expect(stdout).toContain("--slug");
	});
});
