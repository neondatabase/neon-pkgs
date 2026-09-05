import { describe, expect } from "vitest";

import { test } from "../test_utils/fixtures";

describe("help", () => {
	test("without args", async ({ testCliCommand }) => {
		await testCliCommand([], {
			snapshot: false,
			stdout: expect.stringContaining(`neon <command> [options]`),
			stderr: "",
		});
	});
});
