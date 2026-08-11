import { describe, expect, it } from "vitest";

import commands from "./index.js";

// A broken command module (missing/mis-typed `builder`, a bad `command` field, or forgetting
// to add it to the registry) is a classic refactor regression that otherwise only shows up
// when a user runs that exact command. This locks in the yargs command-module contract for
// every entry in `commands/index.ts`, and grows automatically as new commands are added.

function assertRecord(
	value: unknown,
): asserts value is Record<string, unknown> {
	if (typeof value !== "object" || value === null) {
		throw new Error(
			`Expected a command module object, got ${typeof value}`,
		);
	}
}

/** The leading verb of a yargs `command` field (`'projects'`, `'config <sub>'`, aliases…). */
const verbOf = (command: unknown): string => {
	const first = Array.isArray(command) ? command[0] : command;
	return typeof first === "string" && first.length > 0
		? first.split(" ")[0]
		: "<unknown>";
};

// Project the registry into plain, closure-safe descriptors up front. Doing the narrowing
// here (not inside each `it`) keeps the assertions simple and avoids per-module union types.
const registered = commands.map((mod) => {
	assertRecord(mod);
	return {
		verb: verbOf(mod.command),
		describe: mod.describe,
		builderType: typeof mod.builder,
	};
});

describe("command registration", () => {
	it("registers the full command surface", () => {
		// Guards against an accidental truncation of the registry array.
		expect(registered.length).toBeGreaterThanOrEqual(20);
	});

	it("registers `list` as a top-level projects-list alias", () => {
		expect(registered.map(({ verb }) => verb)).toContain("list");
	});

	for (const { verb, describe: description, builderType } of registered) {
		it(`"${verb}" exports a valid yargs command module`, () => {
			expect(verb).not.toBe("<unknown>");
			// `describe` is the help string; yargs allows `false` to hide a command.
			expect(
				typeof description === "string" || description === false,
			).toBe(true);
			// Every command wires its options/subcommands through a builder function.
			expect(builderType).toBe("function");
		});
	}
});
