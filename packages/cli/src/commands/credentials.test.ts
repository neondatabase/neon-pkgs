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

	test("reveal json carries the issuing branch_id when it differs from --branch", async ({
		testCliCommand,
	}) => {
		const { stdout } = await testCliCommand(
			[
				"credentials",
				"reveal",
				"cred-parent-123",
				...PROJECT,
				"--branch",
				"br-sunny-branch-123456",
			],
			{ output: "json", snapshot: false },
		);
		expect(JSON.parse(stdout)).toMatchObject({
			token_id: "cred-parent-123",
			branch_id: "br-parent-branch-123456",
			name: "Default AI gateway credential",
			scopes: ["ai_gateway:invoke"],
			api_token: "parent-branch-api-token",
			s3_secret_access_key: "parent-branch-s3-secret",
		});
	});

	test("reveal of a credential the branch does not list warns and omits branch_id", async ({
		testCliCommand,
	}) => {
		const { stdout, stderr } = await testCliCommand(
			["credentials", "reveal", "cred-other-branch", ...PROJECT],
			{ output: "json", snapshot: false },
		);
		expect(JSON.parse(stdout)).toEqual({
			token_id: "cred-other-branch",
			api_token: "other-branch-api-token",
			s3_secret_access_key: "other-branch-s3-secret",
		});
		expect(stderr).toContain(
			"WARNING: Credential cred-other-branch is not listed on branch br-main-branch-123456, so the output has no branch_id, name, or scopes. Confirm which branch issued it before you use it on br-main-branch-123456.",
		);
	});

	test("rotate", async ({ testCliCommand }) => {
		await testCliCommand(
			["credentials", "rotate", "cred-test-123", ...PROJECT],
			{
				stderr: expect.stringContaining(
					"A replica may briefly accept the previous secret",
				),
			},
		);
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
