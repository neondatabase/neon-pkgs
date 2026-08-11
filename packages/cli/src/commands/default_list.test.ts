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
	"projects",
	"branches",
])("%s default list command", (command) => {
	it("exposes list, not the internal default alias, in shell completion", () => {
		const completions = completionsFor(command);

		expect(completions).toMatch(/^list(?::.*)?$/m);
		expect(completions).not.toMatch(/^\$0(?::.*)?$/m);
	});
});
