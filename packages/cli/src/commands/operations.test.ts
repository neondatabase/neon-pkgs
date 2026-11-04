import { describe, expect } from "vitest";

import { test } from "../test_utils/fixtures";

describe("operations", () => {
	test("list", async ({ testCliCommand }) => {
		await testCliCommand(["operations", "list", "--project-id", "test"]);
	});

	test("get", async ({ testCliCommand }) => {
		const requests: string[] = [];
		await testCliCommand(
			["operations", "get", "op-get-finished", "--project-id", "test"],
			{
				output: "table",
				onRequest: (r) => requests.push(`${r.method} ${r.path}`),
			},
		);
		expect(requests).toEqual([
			"GET /projects/test/operations/op-get-finished",
		]);
	});

	test("get shows the error and retry time of a failed operation", async ({
		testCliCommand,
	}) => {
		await testCliCommand(
			["operations", "get", "op-get-failed", "--project-id", "test"],
			{ output: "table" },
		);
	});

	test("get on an unknown operation exits 1", async ({ testCliCommand }) => {
		await testCliCommand(
			["operations", "get", "op-missing", "--project-id", "test"],
			{ code: 1, snapshot: false, stderr: "ERROR: Not Found" },
		);
	});
});
