import { describe, expect } from "vitest";

import { test } from "../test_utils/fixtures";

const PROJECT = ["--project-id", "test"];

describe("credentials", () => {
	test("list", async ({ testCliCommand }) => {
		await testCliCommand(["credentials", "list", ...PROJECT]);
	});

	test("create", async ({ testCliCommand }) => {
		await testCliCommand([
			"credentials",
			"create",
			...PROJECT,
			"--name",
			"app",
			"--scope",
			"storage:read",
			"--scope",
			"storage:write",
		]);
	});

	test("reveal", async ({ testCliCommand }) => {
		await testCliCommand([
			"credentials",
			"reveal",
			"cred-test-123",
			...PROJECT,
		]);
	});

	test("rotate", async ({ testCliCommand }) => {
		await testCliCommand([
			"credentials",
			"rotate",
			"cred-test-123",
			...PROJECT,
		]);
	});

	test("revoke", async ({ testCliCommand }) => {
		await testCliCommand([
			"credentials",
			"revoke",
			"cred-test-123",
			...PROJECT,
		]);
	});

	test("reveal on a missing credential reports a credential-specific not-found", async ({
		testCliCommand,
	}) => {
		const { stderr, code } = await testCliCommand(
			["credentials", "reveal", "cred-missing", ...PROJECT],
			{ code: 1, snapshot: false },
		);
		expect(code).toBe(1);
		expect(stderr).toContain("Credential cred-missing not found on branch");
	});

	test("revoke on a missing credential reports a credential-specific not-found", async ({
		testCliCommand,
	}) => {
		const { stderr, code } = await testCliCommand(
			["credentials", "revoke", "cred-missing", ...PROJECT],
			{ code: 1, snapshot: false },
		);
		expect(code).toBe(1);
		expect(stderr).toContain("Credential cred-missing not found on branch");
	});

	test("credential alias works", async ({ testCliCommand }) => {
		await testCliCommand(["credential", "list", ...PROJECT]);
	});

	test("reveal table keeps secrets off the grid", async ({
		testCliCommand,
	}) => {
		await testCliCommand(
			["credentials", "reveal", "cred-test-123", ...PROJECT],
			{ outputTable: true },
		);
	});
});
