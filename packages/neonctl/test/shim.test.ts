import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";

const shim = fileURLToPath(new URL("../bin/cli.js", import.meta.url));

const primaryVersion = (
	JSON.parse(
		readFileSync(
			new URL("../../cli/package.json", import.meta.url),
			"utf8",
		),
	) as { version: string }
).version;

// npm and Homebrew expose each `bin` entry as a link named after the command,
// and the CLI brands its help from the name it was invoked as — so the commands
// have to be exercised through links, not through the shim's own path.
const commands = mkdtempSync(join(tmpdir(), "neon-shim-"));
for (const name of ["neonctl", "neon"]) {
	symlinkSync(shim, join(commands, name));
}

const run = (command: string, ...args: string[]): string => {
	const result = spawnSync(
		process.execPath,
		[join(commands, command), ...args],
		{
			encoding: "utf8",
		},
	);
	expect(result.status, result.stderr).toBe(0);
	return `${result.stdout}${result.stderr}`;
};

describe.each(["neonctl", "neon"])("%s", (command) => {
	test("reports the version of the primary neon package", () => {
		expect(run(command, "--version").trim()).toBe(primaryVersion);
	});

	test("brands its help with the invoked command name", () => {
		expect(run(command, "--help")).toMatch(
			new RegExp(`^${command} <command> \\[options\\]`, "m"),
		);
	});
});
