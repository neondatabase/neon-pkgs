import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const shim = fileURLToPath(new URL("../bin/neonctl.js", import.meta.url));

const primaryVersion = (
	JSON.parse(
		readFileSync(
			new URL("../../cli/package.json", import.meta.url),
			"utf8",
		),
	) as { version: string }
).version;

const runShim = (...args: string[]): string => {
	const result = spawnSync(process.execPath, [shim, ...args], {
		encoding: "utf8",
	});
	expect(result.status, result.stderr).toBe(0);
	return `${result.stdout}${result.stderr}`;
};

describe("neonctl shim", () => {
	test("reports the version of the primary neon package", () => {
		expect(runShim("--version").trim()).toBe(primaryVersion);
	});

	test("keeps the neonctl command name in help output", () => {
		expect(runShim("--help")).toMatch(/^neonctl <command> \[options\]/m);
	});
});
