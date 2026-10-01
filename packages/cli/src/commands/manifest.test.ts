import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import yargs from "yargs";
import commands from "./index.js";
import {
	commandManifest,
	preloadCommand,
	selectCommand,
	selectCompletionCommand,
} from "./manifest.js";

// `neon --help` lists commands from the manifest without importing them, so a manifest that
// drifts from a module's own exports changes help and routing without any import failing.

describe("command manifest", () => {
	it("lists every registered command in registration order", () => {
		expect(commandManifest.map((entry) => entry.command)).toEqual(
			commands.map((mod) => mod.command),
		);
	});

	for (const [index, entry] of commandManifest.entries()) {
		it(`"${entry.command}" matches its module's exports`, async () => {
			const mod = await entry.load();
			const registered = commands[index];
			expect(mod).toBe(registered);
			expect(entry.command).toBe(registered.command);
			expect(entry.describe).toBe(registered.describe);
			expect(entry.aliases).toEqual(
				"aliases" in registered ? registered.aliases : undefined,
			);
		});
	}
});

describe("selectCommand", () => {
	it("selects by name, alias, or a name with positionals", () => {
		expect(selectCommand(["projects", "list"])?.command).toBe("projects");
		expect(selectCommand(["db"])?.command).toBe("databases");
		expect(selectCommand(["cs", "main"])?.command).toBe(
			"connection-string [branch]",
		);
	});

	it("skips `completion` and stops at the first unknown positional", () => {
		expect(selectCommand(["completion", "projects"])?.command).toBe(
			"projects",
		);
		expect(selectCommand(["nope", "projects"])).toBeUndefined();
		expect(selectCommand([])).toBeUndefined();
	});
});

describe("selectCompletionCommand", () => {
	it("selects the first word that is a command's name, at any position", () => {
		expect(
			selectCompletionCommand(["neon", "projects", "list", ""])?.command,
		).toBe("projects");
		expect(selectCompletionCommand(["neon", "pro"])).toBeUndefined();
	});

	it("skips aliases, which yargs' completion does not look up", () => {
		expect(
			selectCompletionCommand([
				"neon",
				"--profile",
				"db",
				"--context-file",
				"projects",
				"",
			])?.command,
		).toBe("projects");
	});
});

describe("preloadCommand", () => {
	const cli = () =>
		yargs([])
			.option("api-key", { type: "string" })
			.option("output", { alias: "o", type: "string" })
			.parserConfiguration({ "populate--": true });

	it("treats an option's value as that value, not as a command", async () => {
		const entry = await preloadCommand(cli(), [
			"--api-key",
			"projects",
			"branches",
			"list",
		]);
		expect(entry?.command).toBe("branches");
	});

	it("handles aliased and `=` options before the command", async () => {
		expect(
			(await preloadCommand(cli(), ["-o", "json", "projects", "list"]))
				?.command,
		).toBe("projects");
		expect(
			(
				await preloadCommand(cli(), [
					"--api-key=projects",
					"roles",
					"list",
				])
			)?.command,
		).toBe("roles");
	});

	it("ignores arguments after `--`", async () => {
		expect(
			(await preloadCommand(cli(), ["psql", "--", "projects"]))?.command,
		).toBe("psql [branch]");
	});

	it("treats --get-yargs-completions after `--` as an argument", async () => {
		expect(
			(
				await preloadCommand(cli(), [
					"projects",
					"get",
					"--help",
					"--",
					"--get-yargs-completions",
				])
			)?.command,
		).toBe("projects");
	});

	it("follows completion words after --get-yargs-completions", async () => {
		expect(
			(
				await preloadCommand(cli(), [
					"--get-yargs-completions",
					"neon",
					"branches",
					"",
				])
			)?.command,
		).toBe("branches");
	});
});

describe("shell completion through dist/cli.js", () => {
	it("completes subcommands when an option value is another command's alias", () => {
		const home = mkdtempSync(join(tmpdir(), "neon-completion-"));
		try {
			const stdout = execFileSync(
				process.execPath,
				[
					join(process.cwd(), "dist/cli.js"),
					"--get-yargs-completions",
					"neon",
					"--profile",
					"db",
					"--context-file",
					"projects",
					"",
				],
				{
					cwd: home,
					env: { PATH: process.env.PATH, HOME: home, CI: "true" },
				},
			).toString();
			expect(stdout.split("\n")).toEqual(
				expect.arrayContaining(["list", "create", "get"]),
			);
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});
});
