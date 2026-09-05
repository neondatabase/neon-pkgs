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
			const { stderr: bare } = await testCliCommand([verb], {
				snapshot: false,
			});
			const { stderr: flagged } = await testCliCommand([verb, "--help"], {
				snapshot: false,
			});
			const text = strip(bare);
			expect(text).toBe(strip(flagged));
			expect(text).toContain("Commands:");
			expect(text).not.toMatch(/ERROR:/);
		});
	}
});
