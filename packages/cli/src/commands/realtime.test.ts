import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect } from "vitest";
import { test } from "../test_utils/fixtures.js";
import { disable, enable } from "./realtime.js";

describe("realtime", () => {
	let workspace: string;

	beforeEach(() => {
		workspace = mkdtempSync(join(tmpdir(), "neonctl-realtime-"));
	});

	afterEach(() => {
		rmSync(workspace, { recursive: true, force: true });
	});

	test("enable declares Realtime without making an API request", async ({
		testCliCommand,
	}) => {
		await testCliCommand(["realtime", "enable", "--no-install"], {
			unreachableHost: true,
			code: 0,
			cwd: workspace,
			snapshot: false,
		});

		expect(readFileSync(join(workspace, "neon.ts"), "utf8")).toContain(
			"realtime: true",
		);
	});

	test("enable writes and updates allowed origins", async ({
		testCliCommand,
	}) => {
		await testCliCommand(
			[
				"realtime",
				"enable",
				"--no-install",
				"--allowed-origin",
				"https://app.example.com",
			],
			{
				unreachableHost: true,
				code: 0,
				cwd: workspace,
				snapshot: false,
			},
		);
		await enable({
			cwd: workspace,
			install: false,
			allowedOrigins: ["http://localhost:3000"],
		});

		expect(readFileSync(join(workspace, "neon.ts"), "utf8")).toContain(
			'realtime: { allowedOrigins: ["http://localhost:3000"] }',
		);
	});

	test("disable writes false and enable can turn it back on", async () => {
		await disable({ cwd: workspace, install: false });
		expect(readFileSync(join(workspace, "neon.ts"), "utf8")).toContain(
			"realtime: false",
		);

		await enable({ cwd: workspace, install: false });
		expect(readFileSync(join(workspace, "neon.ts"), "utf8")).toContain(
			"realtime: true",
		);
	});

	test("rejects an invalid allowed origin before creating neon.ts", async () => {
		await expect(
			enable({
				cwd: workspace,
				install: false,
				allowedOrigins: ["https://app.example.com/path"],
			}),
		).rejects.toThrow("http(s) origin with no path");
	});
});
