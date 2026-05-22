#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import yargs from "yargs";
import { hideBin } from "yargs/helpers";
import {
	type CommandResult,
	runContext,
	runPull,
	runPush,
} from "./lib/cli/commands.js";
import { isPullOutputFormat, type PullOutputFormat } from "./lib/cli/format.js";

const pkgVersion = readPackageVersion();

const argv = yargs(hideBin(process.argv))
	.scriptName("neon-platform")
	.usage("$0 <command> [options]")
	.command(
		"pull",
		"Pull the live Neon project state and print it as `neon.ts` (or JSON).",
		(y) =>
			y
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
				})
				.option("format", {
					type: "string",
					choices: ["ts", "json"] as const,
					default: "ts" as const,
					describe:
						"Output format. `ts` emits a neon.ts snippet; `json` emits the raw Config",
				}),
	)
	.command(
		"push",
		"Push your local neon.ts to the resolved Neon project.",
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
				.option("org-id", {
					type: "string",
					describe: "Override the .neon/project.json orgId",
				})
				.option("api-key", {
					type: "string",
					describe: "Neon API key (defaults to NEON_API_KEY)",
				})
				.option("apply-changes", {
					type: "boolean",
					default: false,
					describe:
						"Force-apply even when local config conflicts with remote state",
				})
				.option("update-existing", {
					type: "boolean",
					default: false,
					describe:
						"Update existing specific-name branches' settings/TTL instead of reporting them as conflicts",
				})
				.option("apply-existing", {
					type: "boolean",
					default: false,
					describe:
						"Apply wildcard-blueprint settings/TTL to every matching existing branch",
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
	.demandCommand(
		1,
		"Run `neon-platform --help` to see the available commands.",
	)
	.strict()
	.help()
	.version(pkgVersion)
	.parseSync();

const command = String(argv._[0]);
const env: Record<string, string | undefined> = { ...process.env };
const cwd = process.cwd();

let result: CommandResult;
switch (command) {
	case "pull": {
		const format: PullOutputFormat = isPullOutputFormat(argv.format)
			? argv.format
			: "ts";
		result = await runPull(
			{
				...(typeof argv["project-id"] === "string"
					? { projectId: argv["project-id"] }
					: {}),
				...(typeof argv["org-id"] === "string"
					? { orgId: argv["org-id"] }
					: {}),
				...(typeof argv["api-key"] === "string"
					? { apiKey: argv["api-key"] }
					: {}),
				format,
			},
			{ cwd, env },
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
				...(typeof argv["org-id"] === "string"
					? { orgId: argv["org-id"] }
					: {}),
				...(typeof argv["api-key"] === "string"
					? { apiKey: argv["api-key"] }
					: {}),
				applyChanges: argv["apply-changes"] === true,
				updateExisting: argv["update-existing"] === true,
				applyExisting: argv["apply-existing"] === true,
			},
			{ cwd, env },
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
			{ cwd, env },
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
