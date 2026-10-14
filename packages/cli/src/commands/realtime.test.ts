import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect } from "vitest";
import { test } from "../test_utils/fixtures.js";

// The fixture sends requests to a local mock through --api-host.
const STAGING = { NEON_STAGING_API_HOST: "http://localhost" };

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
				env: STAGING,
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
			env: STAGING,
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
				env: { NEON_STAGING_API_HOST: "http://127.0.0.1" },
				code: 1,
				snapshot: false,
				stderr: 'ERROR: Invalid Neon config: - preview.realtime.allowedOrigins[0]: expected "*" or an http(s) origin with no path, query, or fragment',
			},
		);
	});

	for (const args of [
		["realtime", "enable", "--project-id", "test"],
		["realtime", "subscribe", "SELECT 1"],
	]) {
		test(`${args[1]} explains Realtime is coming soon outside staging`, async ({
			testCliCommand,
		}) => {
			await testCliCommand(args, {
				code: 1,
				snapshot: false,
				stderr: expect.stringContaining(
					"ERROR: Neon Realtime is coming soon!",
				),
			});
		});
	}
});
