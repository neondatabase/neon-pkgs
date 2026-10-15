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

	test("rotate-secret waits for the new secret by default", async ({
		testCliCommand,
	}) => {
		await testCliCommand(
			[
				"realtime",
				"rotate-secret",
				"--project-id",
				"test",
				"--branch",
				"sunny",
			],
			{
				mockDir: "realtime",
				env: {
					NEON_REALTIME_POLL_INTERVAL_MS: "1",
				},
				snapshot: false,
				stderr:
					"Realtime secret rotation requested for branch br-sunny-branch-123456. " +
					"Realtime secret rotation completed for branch br-sunny-branch-123456. " +
					"Run neon env pull --service realtime to update NEON_REALTIME_SECRET.",
			},
		);
	});

	test("rotate-secret --no-wait returns after requesting rotation", async ({
		testCliCommand,
	}) => {
		await testCliCommand(
			[
				"realtime",
				"rotate-secret",
				"--project-id",
				"test",
				"--branch",
				"br-sunny-branch-123456",
				"--no-wait",
			],
			{
				mockDir: "realtime-rotate-no-wait",
				snapshot: false,
				stderr: "Realtime secret rotation requested for branch br-sunny-branch-123456.",
			},
		);
	});

	test("rotate-secret explains that rotation may continue after a timeout", async ({
		testCliCommand,
	}) => {
		await testCliCommand(
			[
				"realtime",
				"rotate-secret",
				"--project-id",
				"test",
				"--branch",
				"br-sunny-branch-123456",
			],
			{
				mockDir: "realtime-rotate-timeout",
				env: {
					NEON_REALTIME_POLL_INTERVAL_MS: "1",
					NEON_REALTIME_POLL_TIMEOUT_MS: "10",
				},
				code: 1,
				snapshot: false,
				stderr:
					"Realtime secret rotation requested for branch br-sunny-branch-123456. " +
					"ERROR: Timed out waiting for Realtime secret rotation on branch br-sunny-branch-123456. " +
					"It may still be in progress.",
			},
		);
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
