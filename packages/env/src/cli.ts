#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import {
	type CommandResult,
	runEnvExport,
	runEnvRun,
} from "./lib/cli/commands.js";

const pkgVersion = readPackageVersion();

const argv = yargs(hideBin(process.argv))
	.scriptName("neon-env")
	.usage("$0 <command> [options]")
	.parserConfiguration({ "populate--": true })
	.option("debug", {
		type: "boolean",
		default: false,
		describe:
			"Print stack traces and structured error details when something fails",
	})
	.command(
		"run",
		"Run a command with Neon env vars (from your neon.ts policy) injected into its environment. Use `--` to separate the command: `neon-env run -- npm run dev`.",
		(y) =>
			y
				.option("config", {
					type: "string",
					describe:
						"Path to neon.ts (defaults to walking up from cwd)",
				})
				.option("project-id", {
					type: "string",
					describe: "Override the .neon/project.json projectId",
				})
				.option("branch", {
					type: "string",
					describe:
						"Branch name or id to target (overrides .neon / NEON_BRANCH / NEON_BRANCH_ID)",
				})
				.option("api-key", {
					type: "string",
					describe: "Neon API key (defaults to NEON_API_KEY)",
				})
				.option("profile", {
					type: "string",
					describe:
						"Neon CLI profile whose stored credential to use (defaults to NEON_PROFILE, else DEFAULT)",
				}),
	)
	.command(
		"export",
		"Print the branch's Neon env vars (from your neon.ts policy) to stdout, as dotenv lines or JSON. Useful for piping into other env tools, e.g. `neon-env export --format json`.",
		(y) =>
			y
				.option("format", {
					choices: ["dotenv", "json"] as const,
					default: "dotenv",
					describe: "Output format: dotenv (KEY=value lines) or json",
				})
				.option("config", {
					type: "string",
					describe:
						"Path to neon.ts (defaults to walking up from cwd)",
				})
				.option("project-id", {
					type: "string",
					describe: "Override the .neon/project.json projectId",
				})
				.option("branch", {
					type: "string",
					describe:
						"Branch name or id to target (overrides .neon / NEON_BRANCH / NEON_BRANCH_ID)",
				})
				.option("api-key", {
					type: "string",
					describe: "Neon API key (defaults to NEON_API_KEY)",
				})
				.option("profile", {
					type: "string",
					describe:
						"Neon CLI profile whose stored credential to use (defaults to NEON_PROFILE, else DEFAULT)",
				}),
	)
	.demandCommand(1, "Run `neon-env --help` to see the available commands.")
	.strict()
	.help()
	.version(pkgVersion)
	.parseSync();

const command = String(argv._[0]);
const cwd = process.cwd();

let result: CommandResult;
switch (command) {
	case "run": {
		const passthrough = Array.isArray(argv["--"])
			? argv["--"].map(String)
			: [];
		result = await runEnvRun(
			{
				command: passthrough,
				...(typeof argv.config === "string"
					? { configPath: argv.config }
					: {}),
				...(typeof argv["project-id"] === "string"
					? { projectId: argv["project-id"] }
					: {}),
				...(typeof argv.branch === "string"
					? { branch: argv.branch }
					: {}),
				...(typeof argv["api-key"] === "string"
					? { apiKey: argv["api-key"] }
					: {}),
				...(typeof argv.profile === "string"
					? { profile: argv.profile }
					: {}),
			},
			{ cwd },
		);
		break;
	}
	case "export": {
		result = await runEnvExport(
			{
				format: argv.format === "json" ? "json" : "dotenv",
				...(typeof argv.config === "string"
					? { configPath: argv.config }
					: {}),
				...(typeof argv["project-id"] === "string"
					? { projectId: argv["project-id"] }
					: {}),
				...(typeof argv.branch === "string"
					? { branch: argv.branch }
					: {}),
				...(typeof argv["api-key"] === "string"
					? { apiKey: argv["api-key"] }
					: {}),
				...(typeof argv.profile === "string"
					? { profile: argv.profile }
					: {}),
			},
			{ cwd },
		);
		break;
	}
	default:
		result = {
			exitCode: 1,
			stdout: "",
			stderr: `Unknown command: ${command}\n`,
		};
}

if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
if (argv.debug && result.exitCode !== 0 && result.debugInfo) {
	process.stderr.write(`\n--- debug ---\n${result.debugInfo}\n`);
}
process.exit(result.exitCode);

function readPackageVersion(): string {
	// The built CLI lives at `dist/cli.js`, so `package.json` is one directory up. When
	// running from source (tsx, vitest), the file lives at `src/cli.ts` and `package.json`
	// is again one directory up. Single resolution covers both layouts.
	try {
		const pkgUrl = new URL("../package.json", import.meta.url);
		const raw = readFileSync(fileURLToPath(pkgUrl), "utf-8");
		const parsed = JSON.parse(raw) as { version?: unknown };
		return typeof parsed.version === "string" ? parsed.version : "0.0.0";
	} catch {
		return "0.0.0";
	}
}
