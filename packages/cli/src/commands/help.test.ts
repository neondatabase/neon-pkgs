import strip from "strip-ansi";
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
	"triggers",
	"credentials",
	"config",
	"env",
	"buckets",
	"project",
	"claimable",
] as const;

describe("parent commands print help with no subcommand", () => {
	for (const verb of PARENT_COMMANDS) {
		test(verb, async ({ testCliCommand }) => {
			const { stdout: bare } = await testCliCommand([verb], {
				snapshot: false,
			});
			const { stdout: flagged } = await testCliCommand([verb, "--help"], {
				snapshot: false,
			});
			const text = strip(bare);
			expect(text).toBe(strip(flagged));
			expect(text).toContain("Commands:");
			expect(text).not.toMatch(/ERROR:/);
		});
	}
});
