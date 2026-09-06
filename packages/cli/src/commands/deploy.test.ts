import { describe, expect } from "vitest";
import { test } from "../test_utils/fixtures";

describe("deploy", () => {
	test("help distinguishes neon deploy from neon functions deploy", async ({
		testCliCommand,
	}) => {
		await testCliCommand(["deploy", "--help"], {
			mockDir: "single_org",
			snapshot: false,
			stdout: expect.stringContaining(
				"Use neon deploy with a neon.ts file for a full deployment",
			),
		});
		await testCliCommand(["deploy", "--help"], {
			mockDir: "single_org",
			snapshot: false,
			stdout: expect.stringContaining(
				"neon deploy --env <file> loads that .env file",
			),
		});
	});
});
