import { describe, expect } from "vitest";

import { test } from "../test_utils/fixtures";

const BRANCH = ["--project-id", "test", "--branch", "test_branch"];

describe("triggers", () => {
	test("list", async ({ testCliCommand }) => {
		await testCliCommand(["triggers", "list", ...BRANCH]);
	});

	test("get", async ({ testCliCommand }) => {
		await testCliCommand([
			"triggers",
			"get",
			"trigger-test-123",
			...BRANCH,
		]);
	});

	test("get table shows function_path", async ({ testCliCommand }) => {
		const { stdout } = await testCliCommand(
			["triggers", "get", "trigger-test-123", ...BRANCH],
			{ outputTable: true, snapshot: false },
		);
		expect(stdout).toContain("Function Path");
		expect(stdout).toContain("/");
	});

	test("list table shows type and storage match", async ({
		testCliCommand,
	}) => {
		const { stdout } = await testCliCommand(
			["triggers", "list", ...BRANCH],
			{ outputTable: true, snapshot: false },
		);
		expect(stdout).toContain("Type");
		expect(stdout).toContain("schedule");
		expect(stdout).toContain("storage_object_created");
		expect(stdout).toContain("Storage");
		expect(stdout).toContain("uploads incoming/");
		expect(stdout).toContain("*/15 * * * *");
	});

	test("get storage trigger", async ({ testCliCommand }) => {
		await testCliCommand([
			"triggers",
			"get",
			"trigger-storage-123",
			...BRANCH,
		]);
	});

	test("enable storage trigger sends storage type", async ({
		testCliCommand,
	}) => {
		await testCliCommand([
			"triggers",
			"enable",
			"trigger-storage-123",
			...BRANCH,
		]);
	});

	test("update storage trigger name", async ({ testCliCommand }) => {
		await testCliCommand([
			"triggers",
			"update",
			"trigger-storage-123",
			...BRANCH,
			"--name",
			"ingest-uploads",
		]);
	});

	test("update storage trigger rejects --cron", async ({
		testCliCommand,
	}) => {
		const { stderr, code } = await testCliCommand(
			[
				"triggers",
				"update",
				"trigger-storage-123",
				...BRANCH,
				"--cron",
				"0 3 * * *",
			],
			{ code: 1, snapshot: false },
		);
		expect(code).toBe(1);
		expect(stderr).toContain(
			"Trigger trigger-storage-123 is type storage_object_created; --cron applies to schedule triggers.",
		);
	});

	test("create", async ({ testCliCommand }) => {
		await testCliCommand([
			"triggers",
			"create",
			...BRANCH,
			"--function-slug",
			"uptime",
			"--name",
			"uptime-check",
			"--cron",
			"*/15 * * * *",
		]);
	});

	test("update", async ({ testCliCommand }) => {
		await testCliCommand([
			"triggers",
			"update",
			"trigger-test-123",
			...BRANCH,
			"--cron",
			"0 3 * * *",
		]);
	});

	test("enable", async ({ testCliCommand }) => {
		await testCliCommand([
			"triggers",
			"enable",
			"trigger-test-123",
			...BRANCH,
		]);
	});

	test("disable", async ({ testCliCommand }) => {
		await testCliCommand([
			"triggers",
			"disable",
			"trigger-test-123",
			...BRANCH,
		]);
	});

	test("delete", async ({ testCliCommand }) => {
		await testCliCommand([
			"triggers",
			"delete",
			"trigger-test-123",
			...BRANCH,
		]);
	});

	test("get on a missing trigger reports a trigger-specific not-found", async ({
		testCliCommand,
	}) => {
		const { stderr, code } = await testCliCommand(
			["triggers", "get", "trigger-missing", ...BRANCH],
			{ code: 1, snapshot: false },
		);
		expect(code).toBe(1);
		expect(stderr).toContain("Trigger trigger-missing not found on branch");
	});

	test("delete on a missing trigger reports a trigger-specific not-found", async ({
		testCliCommand,
	}) => {
		const { stderr, code } = await testCliCommand(
			["triggers", "delete", "trigger-missing", ...BRANCH],
			{ code: 1, snapshot: false },
		);
		expect(code).toBe(1);
		expect(stderr).toContain("Trigger trigger-missing not found on branch");
	});

	test("update with no fields names the flags to pass", async ({
		testCliCommand,
	}) => {
		const { stderr, code } = await testCliCommand(
			["triggers", "update", "trigger-test-123", ...BRANCH],
			{ code: 1, snapshot: false },
		);
		expect(code).toBe(1);
		expect(stderr).toContain("No fields to update");
		expect(stderr).toContain("--cron");
	});

	test("update with a missing target function is left untranslated", async ({
		testCliCommand,
	}) => {
		const { stderr, code } = await testCliCommand(
			[
				"triggers",
				"update",
				"trigger-test-123",
				...BRANCH,
				"--function-slug",
				"ghostfn",
			],
			{ code: 1, snapshot: false },
		);
		expect(code).toBe(1);
		// The distinct missing-function 404 passes through, NOT the trigger-not-found message.
		expect(stderr).toContain("target function not visible on branch");
		expect(stderr).not.toContain("not found on branch");
	});
});
