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

const NESTED_PARENT_COMMANDS = [
	["vpc", "endpoint"],
	["vpc", "project"],
	["neon-auth", "oauth-provider"],
	["neon-auth", "domain"],
	["neon-auth", "config"],
	["neon-auth", "plugins"],
	["neon-auth", "user"],
	["snapshots", "schedule"],
	["inspect", "db"],
	["functions", "domains"],
	["config", "add"],
	["buckets", "object"],
	["bucket", "object"],
] as const;

describe("parent commands print help with no subcommand", () => {
	for (const path of [
		...PARENT_COMMANDS.map((verb) => [verb]),
		...NESTED_PARENT_COMMANDS,
	]) {
		test(path.join(" "), async ({ testCliCommand }) => {
			const { stdout: bare, stderr } = await testCliCommand([...path], {
				snapshot: false,
			});
			const { stdout: flagged } = await testCliCommand(
				[...path, "--help"],
				{ snapshot: false },
			);
			const text = strip(bare);
			expect(text).toBe(strip(flagged));
			expect(text).toContain("Commands:");
			expect(text).not.toMatch(/ERROR:/);
			expect(stderr).toBe("");
		});
	}
});

const USAGE_ERRORS = [
	{
		args: ["roles", "create", "--project-id", "test"],
		error: "Missing required argument: name",
	},
	{
		args: ["branches", "rename", "--project-id", "test"],
		error: "Not enough non-option arguments: got 0, need at least 2",
	},
	{
		args: ["config", "add", "function"],
		error: "Not enough non-option arguments: got 0, need at least 1",
	},
	{
		args: ["vpc", "endpoint", "list"],
		error: "Missing required argument: region-id",
	},
	{
		args: ["config", "add", "bogus"],
		error: "Unknown command: bogus",
		helpFor: ["config", "add"],
	},
	{
		args: ["config", "add", "--output", "bogus"],
		error: 'Invalid values:\n  Argument: output, Given: "bogus", Choices: "json", "yaml", "table"',
		helpFor: ["config", "add"],
	},
] as const;

describe("usage errors print the command's help to stderr", () => {
	for (const { args, error, ...rest } of USAGE_ERRORS) {
		test(args.join(" "), async ({ testCliCommand }) => {
			const { stdout, stderr } = await testCliCommand([...args], {
				snapshot: false,
				code: 1,
			});
			const helpFor = "helpFor" in rest ? rest.helpFor : args;
			const { stdout: help } = await testCliCommand(
				[...helpFor, "--help"],
				{ snapshot: false },
			);
			expect(stdout).toBe("");
			expect(strip(stderr)).toBe(`${strip(help)}ERROR: ${error}\n`);
		});
	}
});
