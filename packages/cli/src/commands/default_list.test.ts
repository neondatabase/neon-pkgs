import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const completionsFor = (command: string) =>
	execFileSync(
		process.execPath,
		[
			join(process.cwd(), "dist/index.js"),
			"--get-yargs-completions",
			"neon",
			command,
			"",
		],
		{ encoding: "utf8" },
	);

describe.each([
	["projects", "List projects"],
	["branches", "List branches"],
])("%s default list command", (command, description) => {
	it("exposes list, not the internal default alias, in shell completion", () => {
		const completions = completionsFor(command);

		expect(completions).toContain(`list:${description}`);
		expect(completions).not.toContain("$0:");
	});
});
