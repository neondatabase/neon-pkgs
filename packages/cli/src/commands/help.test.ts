import strip from "strip-ansi";
import { describe, expect } from "vitest";

import { test } from "../test_utils/fixtures";

describe("help", () => {
	test("without args", async ({ testCliCommand }) => {
		await testCliCommand([], {
			stderr: expect.stringContaining(`neon <command> [options]`),
		});
	});
});

// Command groups with no action of their own: a bare invocation must print that
// group's help (the same output as `--help`), not "run --help" / demandCommand.
const PARENT_COMMANDS = [
	"profile",
	"api-keys",
	"orgs",
	"projects",
	"ip-allow",
	"vpc",
	"neon-auth",
	"branches",
	"databases",
	"roles",
	"operations",
	"logs",
	"snapshots",
	"inspect",
	"claim",
	"data-api",
	"functions",
	"config",
	"env",
	"buckets",
	"project",
	"claimable",
] as const;

describe("parent commands print help with no subcommand", () => {
	for (const verb of PARENT_COMMANDS) {
		test(verb, async ({ testCliCommand }) => {
			const { stderr } = await testCliCommand([verb], {
				snapshot: false,
			});
			const text = strip(stderr);
			expect(text).toContain("Commands:");
			expect(text).not.toMatch(/ERROR:/);
		});
	}
});
