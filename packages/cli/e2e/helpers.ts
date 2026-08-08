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

/** The published entry point (`bin.neon`), not `dist/index.js`. */
const CLI_ENTRY = resolve(import.meta.dirname, "..", "dist", "cli.js");

/**
 * A scratch directory standing in for the user's home config. Nothing should be written
 * here — every invocation passes `--api-key` — but pointing at it means a developer's
 * real `~/.config/neonctl/credentials.json` can never be picked up and silently make a
 * failing auth path look like it works.
 */
const configDir = mkdtempSync(join(tmpdir(), "neon-e2e-config-"));

/**
 * Likewise for `.neon`: the CLI walks parent directories looking for a context file and
 * would happily inherit an org or project id from the developer's checkout. Pointing at a
 * path inside an empty temp dir keeps every run hermetic.
 */
const contextFile = join(
	mkdtempSync(join(tmpdir(), "neon-e2e-context-")),
	".neon",
);

export type CliResult = {
	code: number;
	stdout: string;
	stderr: string;
};

/**
 * A run that produced no exit code because it outlived {@link RUN_TIMEOUT_MS}. Killing it and
 * reporting beats letting a hung child stall the suite until Vitest's own timeout, which says
 * nothing about which command hung.
 */
const RUN_TIMEOUT_MS = 120_000;

/**
 * Global flags belong before the caller's `--`, not after it. Yargs puts everything past `--`
 * into the passthrough array, so appending `--api-key` to `neon psql -- -c "select 1"` hands
 * the key to psql, which rejects it as an unknown option.
 */
function withGlobalFlags(args: string[], globals: string[]): string[] {
	const separator = args.indexOf("--");
	if (separator === -1) return [...args, ...globals];
	return [...args.slice(0, separator), ...globals, ...args.slice(separator)];
}

/**
 * Run the real CLI the way a user would, minus the parts that would make a test
 * environment-dependent: analytics off, JSON output, isolated config and context.
 */
export function runCli(
	args: string[],
	options: {
		json?: boolean;
		/** Override the shared scratch config directory. Never pass `--config-dir` in `args`. */
		configDir?: string;
		/**
		 * Override the shared scratch `.neon`. Needed by anything that is supposed to read a
		 * project from context — the default points at an empty temp file precisely so a
		 * command cannot pick one up by accident.
		 */
		contextFile?: string;
		/**
		 * Authenticate from this profile. Suppresses `--api-key`, which is the only way to
		 * exercise a stored credential — the two together are rejected on purpose.
		 */
		profile?: string;
		/**
		 * Pass this key as `--api-key`. Defaults to the harness key, and to nothing at all when
		 * `profile` is set. Give both to exercise the rejection.
		 *
		 * `null` passes none. The `profile` subcommands that act on a stored credential refuse
		 * `--api-key` rather than ignoring it, so the default would make them fail — and a case
		 * about reading profiles off disk should not be authenticating in the first place.
		 */
		apiKey?: string | null;
		/** Extra environment for the child. `undefined` removes an inherited variable. */
		env?: Record<string, string | undefined>;
		/** Working directory for the child. Commands that read `.neon` from the cwd need one. */
		cwd?: string;
	} = {},
): Promise<CliResult> {
	const key =
		options.apiKey === null
			? undefined
			: (options.apiKey ??
				(options.profile ? undefined : requireApiKey()));
	const argv = [
		CLI_ENTRY,
		...withGlobalFlags(args, [
			...(key !== undefined ? ["--api-key", key] : []),
			...(options.profile ? ["--profile", options.profile] : []),
			"--config-dir",
			options.configDir ?? configDir,
			// The CLI calls this `--api-host`; the harness contract calls it
			// NEON_API_BASE_URL. Translate so one variable redirects the whole run.
			"--api-host",
			configuredBaseUrl(),
			"--context-file",
			options.contextFile ?? contextFile,
			"--no-analytics",
			// Only when the caller hasn't chosen one. Passing `--output` twice makes yargs
			// hand the command an array, which it does not recognise as "json" — so the run
			// silently prints a table and every JSON.parse downstream fails on a box-drawing
			// character.
			...(args.includes("--output") || args.includes("-o")
				? []
				: ["--output", options.json === false ? "table" : "json"]),
		]),
	];
	const env: Record<string, string | undefined> = {
		...process.env,
		NO_COLOR: "1",
		FORCE_COLOR: "0",
		...(options.env ?? {}),
	};
	for (const [key, value] of Object.entries(env)) {
		if (value === undefined) delete env[key];
	}
	return new Promise((resolvePromise, reject) => {
		const child = spawn(process.execPath, argv, {
			stdio: ["ignore", "pipe", "pipe"],
			env,
			...(options.cwd ? { cwd: options.cwd } : {}),
		});
		let stdout = "";
		let stderr = "";
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			reject(
				new Error(
					`neon ${args.join(" ")} did not exit within ${RUN_TIMEOUT_MS}ms`,
				),
			);
		}, RUN_TIMEOUT_MS);
		child.stdout.on("data", (chunk) => {
			stdout += String(chunk);
		});
		child.stderr.on("data", (chunk) => {
			stderr += String(chunk);
		});
		child.on("error", (err) => {
			clearTimeout(timer);
			reject(err);
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			resolvePromise({ code: code ?? -1, stdout, stderr });
		});
	});
}

/** Run the CLI, require exit code 0, and parse `--output json` into a value. */
export async function runCliJson<T>(args: string[]): Promise<T> {
	const result = await runCli(args);
	if (result.code !== 0) {
		throw new Error(
			`neon ${args.join(" ")} exited ${result.code}\n${result.stderr || result.stdout}`,
		);
	}
	try {
		return JSON.parse(result.stdout) as T;
	} catch {
		throw new Error(
			`neon ${args.join(" ")} did not print JSON:\n${result.stdout}`,
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
