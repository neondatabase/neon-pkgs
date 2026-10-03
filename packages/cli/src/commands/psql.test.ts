import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect } from "vitest";
import { test } from "../test_utils/fixtures";

describe("psql", () => {
	test("psql connects to a branch", async ({ testCliCommand }) => {
		await testCliCommand([
			"psql",
			"test_branch",
			"--project-id",
			"test",
			"--database-name",
			"test_db",
			"--role-name",
			"test_role",
		]);
	});

	test("psql forwards args after --", async ({ testCliCommand }) => {
		await testCliCommand([
			"psql",
			"test_branch",
			"--project-id",
			"test",
			"--database-name",
			"test_db",
			"--role-name",
			"test_role",
			"--",
			"-c",
			"SELECT 1",
		]);
	});

	test("psql pooled", async ({ testCliCommand }) => {
		await testCliCommand([
			"psql",
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

	test("psql without any args should pass", async ({ testCliCommand }) => {
		await testCliCommand(["psql"], {
			mockDir: "single_project",
		});
	});

	test("psql names the connection target on stderr", async ({
		testCliCommand,
	}) => {
		const { stderr } = await testCliCommand(
			[
				"psql",
				"test_branch",
				"--project-id",
				"test",
				"--database-name",
				"test_db",
				"--role-name",
				"test_role",
			],
			{ snapshot: false },
		);
		expect(stderr).toMatch(
			/^INFO: Neon connection: test_db as test_role on \S+; launching psql\.\.\.$/m,
		);
		expect(stderr).not.toContain("test_pwd");
	});

	test("psql exits with psql's exit code", async ({ testCliCommand }) => {
		const bin = mkdtempSync(join(tmpdir(), "neon-psql-exit-"));
		writeFileSync(join(bin, "psql"), "#!/bin/sh\nexit 3\n");
		chmodSync(join(bin, "psql"), 0o755);
		await testCliCommand(
			[
				"psql",
				"test_branch",
				"--project-id",
				"test",
				"--database-name",
				"test_db",
				"--role-name",
				"test_role",
			],
			{
				code: 3,
				snapshot: false,
				env: { PATH: `${bin}:${process.env.PATH}` },
			},
		);
	});

	test("psql keeps the generic line when -- arguments pick another target", async ({
		testCliCommand,
	}) => {
		const { stderr } = await testCliCommand(
			[
				"psql",
				"test_branch",
				"--project-id",
				"test",
				"--database-name",
				"test_db",
				"--role-name",
				"test_role",
				"--",
				"-d",
				"other_db",
			],
			{ snapshot: false },
		);
		expect(stderr).toMatch(
			/^INFO: Connecting to the database; launching psql\.\.\.$/m,
		);
	});
});
