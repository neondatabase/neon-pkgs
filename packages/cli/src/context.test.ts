import { afterEach, describe, expect, test } from "vitest";

import { isMcpOauth } from "./context.js";

describe("isMcpOauth", () => {
	const originalArgv = process.argv;

	afterEach(() => {
		process.argv = originalArgv;
	});

	test("is true for --oauth and --oauth=true", () => {
		process.argv = ["node", "neon", "mcp", "--oauth"];
		expect(isMcpOauth({ _: ["mcp"] })).toBe(true);
		process.argv = ["node", "neon", "mcp", "--oauth=true"];
		expect(isMcpOauth({ _: ["mcp"] })).toBe(true);
	});

	test("is false for --oauth=false", () => {
		process.argv = ["node", "neon", "mcp", "--oauth=false"];
		expect(isMcpOauth({ _: ["mcp"] })).toBe(false);
	});
});
