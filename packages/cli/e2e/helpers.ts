import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	configuredBaseUrl,
	configuredOrgId,
	requireApiKey,
} from "@neon/e2e-harness";

export {
	createProject,
	deleteProject,
	e2eTest,
	uniqueProjectName,
	waitForProjectReady,
} from "@neon/e2e-harness";

/** The published entry point (`bin.neonctl`), not `dist/index.js`. */
const CLI_ENTRY = resolve(import.meta.dirname, "..", "dist", "cli.js");

/**
 * A scratch directory standing in for the user's home config. Nothing should be written
 * here — every invocation passes `--api-key` — but pointing at it means a developer's
 * real `~/.config/neonctl/credentials.json` can never be picked up and silently make a
 * failing auth path look like it works.
 */
const configDir = mkdtempSync(join(tmpdir(), "neonctl-e2e-config-"));

/**
 * Likewise for `.neon`: the CLI walks parent directories looking for a context file and
 * would happily inherit an org or project id from the developer's checkout. Pointing at a
 * path inside an empty temp dir keeps every run hermetic.
 */
const contextFile = join(
	mkdtempSync(join(tmpdir(), "neonctl-e2e-context-")),
	".neon",
);

export type CliResult = {
	code: number;
	stdout: string;
	stderr: string;
};

/**
 * Run the real CLI the way a user would, minus the parts that would make a test
 * environment-dependent: analytics off, JSON output, isolated config and context.
 */
export function runCli(
	args: string[],
	options: { json?: boolean } = {},
): Promise<CliResult> {
	const argv = [
		CLI_ENTRY,
		...args,
		"--api-key",
		requireApiKey(),
		// The CLI calls this `--api-host`; the harness contract calls it
		// NEON_API_BASE_URL. Translate so one variable redirects the whole run.
		"--api-host",
		configuredBaseUrl(),
		"--config-dir",
		configDir,
		"--context-file",
		contextFile,
		"--no-analytics",
		"--output",
		options.json === false ? "table" : "json",
	];
	return new Promise((resolvePromise, reject) => {
		const child = spawn(process.execPath, argv, {
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: "0" },
		});
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => {
			stdout += String(chunk);
		});
		child.stderr.on("data", (chunk) => {
			stderr += String(chunk);
		});
		child.on("error", reject);
		child.on("close", (code) => {
			resolvePromise({ code: code ?? -1, stdout, stderr });
		});
	});
}

/** Run the CLI, require exit code 0, and parse `--output json` into a value. */
export async function runCliJson<T>(args: string[]): Promise<T> {
	const result = await runCli(args);
	if (result.code !== 0) {
		throw new Error(
			`neonctl ${args.join(" ")} exited ${result.code}\n${result.stderr || result.stdout}`,
		);
	}
	try {
		return JSON.parse(result.stdout) as T;
	} catch {
		throw new Error(
			`neonctl ${args.join(" ")} did not print JSON:\n${result.stdout}`,
		);
	}
}

/**
 * The CLI reads the org from `--org-id` or a `.neon` context file; unlike the SDK and the
 * harness it does not look at `NEON_ORG_ID`. Commands that need one get it from here.
 */
export function orgArgs(): string[] {
	const org = configuredOrgId();
	return org ? ["--org-id", org] : [];
}
