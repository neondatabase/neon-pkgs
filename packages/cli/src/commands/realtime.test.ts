import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe } from "vitest";
import { test } from "../test_utils/fixtures.js";

describe("realtime", () => {
	let workspace: string;

	beforeEach(() => {
		workspace = mkdtempSync(join(tmpdir(), "neonctl-realtime-"));
	});

	afterEach(() => {
		rmSync(workspace, { recursive: true, force: true });
	});

	test("enable requests Realtime for the selected branch", async ({
		testCliCommand,
	}) => {
		await testCliCommand(
			[
				"realtime",
				"enable",
				"--project-id",
				"test",
				"--branch",
				"sunny",
				"--allowed-origin",
				"https://app.example.com",
				"--allowed-origin",
				"http://localhost:3000",
			],
			{
				mockDir: "realtime",
				snapshot: false,
				stderr: "Realtime enable requested for branch br-sunny-branch-123456.",
			},
		);
	});

	test("disable uses the project and branch linked in .neon", async ({
		testCliCommand,
	}) => {
		writeFileSync(
			join(workspace, ".neon"),
			JSON.stringify({ projectId: "test", branch: "sunny" }),
		);

		await testCliCommand(["realtime", "disable"], {
			mockDir: "realtime",
			cwd: workspace,
			snapshot: false,
			stderr: "Realtime disable requested for branch br-sunny-branch-123456.",
		});
	});

	test("enable rejects an invalid allowed origin before calling the API", async ({
		testCliCommand,
	}) => {
		await testCliCommand(
			[
				"realtime",
				"enable",
				"--project-id",
				"test",
				"--branch",
				"sunny",
				"--allowed-origin",
				"https://app.example.com/path",
			],
			{
				unreachableHost: true,
				code: 1,
				snapshot: false,
				stderr: 'ERROR: Invalid Neon config: - preview.realtime.allowedOrigins[0]: expected "*" or an http(s) origin with no path, query, or fragment',
			},
		);
	});
});
