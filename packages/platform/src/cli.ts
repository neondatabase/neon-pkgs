#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import {
	type CommandResult,
	runBranch,
	runCheckout,
	runContext,
	runEnvPull,
	runEnvRun,
	runInit,
	runPull,
	runPush,
	runStatus,
} from "./lib/cli/commands.js";

const pkgVersion = readPackageVersion();

const argv = yargs(hideBin(process.argv))
	.scriptName("neon-ts")
	.usage("$0 <command> [options]")
	.parserConfiguration({ "populate--": true })
	.option("debug", {
		type: "boolean",
		default: false,
		describe:
			"Print stack traces and structured error details when something fails",
	})
	.command(
		"pull",
		"Print the selected branch's live Neon state as JSON.",
		(y) =>
			y
				.option("project-id", {
					type: "string",
					describe: "Override the .neon/project.json projectId",
				})
				.option("api-key", {
					type: "string",
					describe: "Neon API key (defaults to NEON_API_KEY)",
				})
				.option("branch", {
					type: "string",
					describe:
						"Override the .neon/project.json branchId / NEON_BRANCH_ID",
				}),
	)
	.command(
		"init",
		"Create a starter neon.ts branch-policy file from the selected branch.",
		(y) =>
			y
				.option("project-id", {
					type: "string",
					describe: "Override the .neon/project.json projectId",
				})
				.option("branch", {
					type: "string",
					describe:
						"Override the .neon/project.json branchId / NEON_BRANCH_ID",
				})
				.option("api-key", {
					type: "string",
					describe: "Neon API key (defaults to NEON_API_KEY)",
				}),
	)
	.command(
		"push",
		"Push your local neon.ts policy to the selected Neon branch.",
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
				.option("api-key", {
					type: "string",
					describe: "Neon API key (defaults to NEON_API_KEY)",
				})
				.option("branch", {
					type: "string",
					describe:
						"Override the .neon/project.json branchId / NEON_BRANCH_ID",
				})
				.option("update-existing", {
					type: "boolean",
					default: false,
					describe:
						"Apply mutable drift (branch settings / `protected` flag / project rename) instead of reporting it as a conflict. Immutable fields (region, pgVersion) always remain conflicts.",
				}),
	)
	.command(
		"context",
		"Resolve and print the Neon project + branch context.",
		(y) =>
			y
				.option("branch", {
					type: "string",
					describe:
						"Override the branch id/name from NEON_BRANCH_ID or the context file",
				})
				.option("project-id", {
					type: "string",
					describe: "Override the .neon/project.json projectId",
				})
				.option("org-id", {
					type: "string",
					describe: "Override the .neon/project.json orgId",
				}),
	)
	.command(
		"status",
		"Show what `neon-ts push` would do for the selected branch, no mutations.",
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
				.option("api-key", {
					type: "string",
					describe: "Neon API key (defaults to NEON_API_KEY)",
				})
				.option("branch", {
					type: "string",
					describe:
						"Override the .neon/project.json branchId / NEON_BRANCH_ID",
				}),
	)
	.command(
		"branch <name>",
		"Create a new branch from the neon.ts branch policy.",
		(y) =>
			y
				.positional("name", {
					type: "string",
					describe: "Branch name or pattern to create (e.g. `dev`)",
					demandOption: true,
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
				.option("org-id", {
					type: "string",
					describe: "Override the .neon/project.json orgId",
				})
				.option("api-key", {
					type: "string",
					describe: "Neon API key (defaults to NEON_API_KEY)",
				}),
	)
	.command(
		"checkout <branch>",
		"Check out an existing Neon branch by name or id and update local context.",
		(y) =>
			y
				.positional("branch", {
					type: "string",
					describe: "Branch name or id to check out",
					demandOption: true,
				})
				.option("project-id", {
					type: "string",
					describe: "Override the .neon/project.json projectId",
				})
				.option("org-id", {
					type: "string",
					describe: "Override the .neon/project.json orgId",
				})
				.option("api-key", {
					type: "string",
					describe: "Neon API key (defaults to NEON_API_KEY)",
				}),
	)
	.command("env", "Pull or run with Neon env vars injected.", (env) =>
		env
			.command(
				"pull [file]",
				"Write Neon connection strings to a .env file (default: .env.local).",
				(y) =>
					y
						.positional("file", {
							type: "string",
							describe:
								"Target file path. Defaults to .env.local in the current directory.",
						})
						.option("config", {
							type: "string",
							describe:
								"Path to neon.ts (defaults to walking up from cwd)",
						})
						.option("project-id", {
							type: "string",
							describe:
								"Override the .neon/project.json projectId",
						})
						.option("branch", {
							type: "string",
							describe:
								"Override the .neon/project.json branchId / NEON_BRANCH_ID",
						})
						.option("api-key", {
							type: "string",
							describe: "Neon API key (defaults to NEON_API_KEY)",
						}),
			)
			.command(
				"run",
				"Run a command with Neon env vars injected into its environment. Use `--` to separate the command: `neon-ts env run -- npm run dev`.",
				(y) =>
					y
						.option("config", {
							type: "string",
							describe:
								"Path to neon.ts (defaults to walking up from cwd)",
						})
						.option("project-id", {
							type: "string",
							describe:
								"Override the .neon/project.json projectId",
						})
						.option("branch", {
							type: "string",
							describe:
								"Override the .neon/project.json branchId / NEON_BRANCH_ID",
						})
						.option("api-key", {
							type: "string",
							describe: "Neon API key (defaults to NEON_API_KEY)",
						}),
			)
			.demandCommand(
				1,
				"Run `neon-ts env --help` to see the available subcommands.",
			),
	)
	.demandCommand(1, "Run `neon-ts --help` to see the available commands.")
	.strict()
	.help()
	.version(pkgVersion)
	.parseSync();

const command = String(argv._[0]);
const subcommand = argv._[1] !== undefined ? String(argv._[1]) : undefined;
const cwd = process.cwd();

let result: CommandResult;
switch (command) {
	case "pull": {
		result = await runPull(
			{
				...(typeof argv["project-id"] === "string"
					? { projectId: argv["project-id"] }
					: {}),
				...(typeof argv["api-key"] === "string"
					? { apiKey: argv["api-key"] }
					: {}),
				...(typeof argv.branch === "string"
					? { branch: argv.branch }
					: {}),
			},
			{ cwd },
		);
		break;
	}
	case "init": {
		result = await runInit(
			{
				...(typeof argv["project-id"] === "string"
					? { projectId: argv["project-id"] }
					: {}),
				...(typeof argv.branch === "string"
					? { branch: argv.branch }
					: {}),
				...(typeof argv["api-key"] === "string"
					? { apiKey: argv["api-key"] }
					: {}),
			},
			{ cwd },
		);
		break;
	}
	case "push": {
		result = await runPush(
			{
				...(typeof argv.config === "string"
					? { configPath: argv.config }
					: {}),
				...(typeof argv["project-id"] === "string"
					? { projectId: argv["project-id"] }
					: {}),
				...(typeof argv["api-key"] === "string"
					? { apiKey: argv["api-key"] }
					: {}),
				...(typeof argv.branch === "string"
					? { branch: argv.branch }
					: {}),
				updateExisting: argv["update-existing"] === true,
			},
			{ cwd },
		);
		break;
	}
	case "context": {
		result = runContext(
			{
				...(typeof argv.branch === "string"
					? { branch: argv.branch }
					: {}),
				...(typeof argv["project-id"] === "string"
					? { projectId: argv["project-id"] }
					: {}),
				...(typeof argv["org-id"] === "string"
					? { orgId: argv["org-id"] }
					: {}),
			},
			{ cwd },
		);
		break;
	}
	case "status": {
		result = await runStatus(
			{
				...(typeof argv.config === "string"
					? { configPath: argv.config }
					: {}),
				...(typeof argv["project-id"] === "string"
					? { projectId: argv["project-id"] }
					: {}),
				...(typeof argv["api-key"] === "string"
					? { apiKey: argv["api-key"] }
					: {}),
				...(typeof argv.branch === "string"
					? { branch: argv.branch }
					: {}),
			},
			{ cwd },
		);
		break;
	}
	case "branch": {
		const name = typeof argv.name === "string" ? argv.name : "";
		result = await runBranch(
			{
				name,
				...(typeof argv.config === "string"
					? { configPath: argv.config }
					: {}),
				...(typeof argv["project-id"] === "string"
					? { projectId: argv["project-id"] }
					: {}),
				...(typeof argv["org-id"] === "string"
					? { orgId: argv["org-id"] }
					: {}),
				...(typeof argv["api-key"] === "string"
					? { apiKey: argv["api-key"] }
					: {}),
			},
			{ cwd },
		);
		break;
	}
	case "checkout": {
		const branch = typeof argv.branch === "string" ? argv.branch : "";
		result = await runCheckout(
			{
				branch,
				...(typeof argv["project-id"] === "string"
					? { projectId: argv["project-id"] }
					: {}),
				...(typeof argv["org-id"] === "string"
					? { orgId: argv["org-id"] }
					: {}),
				...(typeof argv["api-key"] === "string"
					? { apiKey: argv["api-key"] }
					: {}),
			},
			{ cwd },
		);
		break;
	}
	case "env": {
		if (subcommand === "pull") {
			result = await runEnvPull(
				{
					...(typeof argv.file === "string"
						? { file: argv.file }
						: {}),
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
				},
				{ cwd },
			);
		} else if (subcommand === "run") {
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
				},
				{ cwd },
			);
		} else {
			result = {
				exitCode: 1,
				stdout: "",
				stderr: `Unknown env subcommand: ${subcommand ?? "(none)"}.\nRun \`neon-ts env --help\` to see the available subcommands.\n`,
			};
		}
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
	// running from source (tsx, ts-node, vitest), the file lives at `src/cli.ts` and
	// `package.json` is again one directory up. Single resolution covers both layouts.
	try {
		const pkgUrl = new URL("../package.json", import.meta.url);
		const raw = readFileSync(fileURLToPath(pkgUrl), "utf-8");
		const parsed = JSON.parse(raw) as { version?: unknown };
		return typeof parsed.version === "string" ? parsed.version : "0.0.0";
	} catch {
		return "0.0.0";
	}
}
