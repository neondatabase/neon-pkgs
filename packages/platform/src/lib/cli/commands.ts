import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { resolveApiKey } from "../auth.js";
import { branch } from "../branch.js";
import { checkout } from "../checkout.js";
import { fetchEnv, neonEnvToProcessEnv } from "../env.js";
import {
	ConfigLoadError,
	ErrorCode,
	MissingContextError,
	PlatformError,
	PushAbortedError,
	PushConflictError,
} from "../errors.js";
import { loadContext } from "../load-context.js";
import { loadConfigFromFile } from "../loader.js";
import type { NeonApi } from "../neon-api.js";
import { createRealNeonApi } from "../neon-api-real.js";
import {
	type EnsurePlatformPackageOptions,
	type EnsurePlatformPackageResult,
	ensurePlatformPackageInstalled,
} from "../package-manager.js";
import { pullConfig } from "../pull-config.js";
import {
	type PushConfigOptions,
	type PushConfirmContext,
	pushConfig,
} from "../push-config.js";
import { formatConfigAsJson, formatInitTemplate } from "./format.js";

/** Filename written by `neon-ts pull` (and read by every other subcommand). */
const NEON_CONFIG_FILENAME = "neon.ts";

/**
 * Cross-cutting environment a CLI command is allowed to touch. Injected so tests can drive
 * the handlers with a `FakeNeonApi` and a controlled `cwd` without spawning child
 * processes. Env vars are read straight from `process.env`; tests use `vi.stubEnv` to
 * control them.
 */
export interface CommandEnv {
	cwd: string;
	/**
	 * When set, used directly as the NeonApi. When omitted, a real adapter is constructed
	 * from `options.apiKey ?? NEON_API_KEY`.
	 */
	api?: NeonApi;
	/**
	 * When set, used instead of the real package-manager install during `init`. Tests inject
	 * a stub so `runInit` does not spawn npm/pnpm/yarn/bun.
	 */
	ensurePlatformPackage?: (
		options: EnsurePlatformPackageOptions,
	) => Promise<EnsurePlatformPackageResult>;
	/**
	 * Yes/no prompt used by `runPush` for protected-branch / override confirmation.
	 * When omitted, a real readline-backed prompt over stdin/stdout is used; tests
	 * inject a stub to drive the interactive flow without a TTY.
	 */
	confirmPrompt?: (message: string) => Promise<boolean>;
}

export interface CommandResult {
	/** Process exit code. `0` for success, non-zero for failure. */
	exitCode: number;
	/** Text intended for stdout (e.g. JSON / TS output). */
	stdout: string;
	/** Text intended for stderr (human-readable status / error messages). */
	stderr: string;
	/**
	 * Optional structured debug payload — stack trace, request id, error code, …
	 * Printed only when the user passes `--debug` to the CLI. Programmatic callers can
	 * read it directly.
	 */
	debugInfo?: string;
}

// ───────────────────────── pull ─────────────────────────

export interface PullCommandOptions {
	projectId?: string;
	branch?: string;
	apiKey?: string;
}

/**
 * Implementation of `neon-ts pull`.
 *
 * Prints the selected branch's current remote state as JSON for copy/paste into the
 * branch-policy function. Use `init` to create a starter `neon.ts`.
 */
export async function runPull(
	options: PullCommandOptions,
	ctx: CommandEnv,
): Promise<CommandResult> {
	const api = resolveApi(options.apiKey, ctx);
	if (typeof api === "string") return failure(api);

	try {
		const config = await pullConfig({
			api,
			cwd: ctx.cwd,
			...(options.projectId ? { projectId: options.projectId } : {}),
			...(options.branch ? { branch: options.branch } : {}),
		});
		return {
			exitCode: 0,
			stdout: formatConfigAsJson(config),
			stderr: "",
		};
	} catch (err) {
		return handleError(err);
	}
}

// ───────────────────────── init ─────────────────────────

export interface InitCommandOptions {
	projectId?: string;
	branch?: string;
	apiKey?: string;
}

export async function runInit(
	options: InitCommandOptions,
	ctx: CommandEnv,
): Promise<CommandResult> {
	const api = resolveApi(options.apiKey, ctx);
	if (typeof api === "string") return failure(api);

	const ensurePlatformPackage =
		ctx.ensurePlatformPackage ?? ensurePlatformPackageInstalled;
	const installResult = await ensurePlatformPackage({ cwd: ctx.cwd });
	if (!installResult.skipped && !installResult.installed) {
		return failure(installResult.message);
	}

	try {
		const pulled = await pullConfig({
			api,
			cwd: ctx.cwd,
			...(options.projectId ? { projectId: options.projectId } : {}),
			...(options.branch ? { branch: options.branch } : {}),
		});
		const targetPath = join(ctx.cwd, NEON_CONFIG_FILENAME);
		const writeResult = writeFileSafely(
			targetPath,
			formatInitTemplate(pulled),
		);
		if (writeResult.exitCode !== 0) return writeResult;

		const installLine = formatInitInstallMessage(installResult);
		return {
			exitCode: 0,
			stdout: `${installLine}${writeResult.stdout}`,
			stderr: writeResult.stderr,
		};
	} catch (err) {
		return handleError(err);
	}
}

// ───────────────────────── push ─────────────────────────

export interface PushCommandOptions {
	configPath?: string;
	projectId?: string;
	branch?: string;
	apiKey?: string;
	updateExisting?: boolean;
	allowProtectedBranch?: boolean;
}

/**
 * Implementation of `neon-ts push`. Loads `neon.ts` (or the path supplied via
 * `--config`), pushes against the resolved project, and prints a human-readable summary
 * of what changed.
 *
 * Interactive by default. When the push targets a protected branch and/or would
 * override existing remote settings, the user is prompted once with a single combined
 * "are you sure?" question. `--allow-protected-branch` and `--update-existing` are the
 * non-interactive ack flags for those cases respectively.
 */
export async function runPush(
	options: PushCommandOptions,
	ctx: CommandEnv,
): Promise<CommandResult> {
	const api = resolveApi(options.apiKey, ctx);
	if (typeof api === "string") return failure(api);

	const confirmPrompt = ctx.confirmPrompt ?? defaultConfirmPrompt;
	const pushOptions: PushConfigOptions = {
		api,
		cwd: ctx.cwd,
		...(options.configPath ? { configPath: options.configPath } : {}),
		...(options.projectId ? { projectId: options.projectId } : {}),
		...(options.branch ? { branch: options.branch } : {}),
		...(options.updateExisting ? { updateExisting: true } : {}),
		...(options.allowProtectedBranch ? { allowProtectedBranch: true } : {}),
		confirm: (context) => confirmPushChanges(context, { confirmPrompt }),
	};

	try {
		const result = await pushConfig(pushOptions);
		const realChanges = result.applied.filter((c) => c.action !== "noop");
		const projectLabel = `project ${result.projectId}${result.orgId ? ` (org ${result.orgId})` : ""} branch ${result.branchName} (${result.branchId})`;

		const lines: string[] = [];
		if (realChanges.length === 0) {
			lines.push(
				`✓ ${projectLabel} is already in sync. No changes needed.`,
			);
		} else {
			lines.push(`✓ pushed config to ${projectLabel}`);
			lines.push("");
			lines.push("Applied:");
			for (const change of realChanges) {
				const verb =
					change.kind === "service" && change.action === "create"
						? "enable"
						: change.action;
				lines.push(`  - [${change.kind}:${change.identifier}] ${verb}`);
			}
		}
		return { exitCode: 0, stdout: `${lines.join("\n")}\n`, stderr: "" };
	} catch (err) {
		return handleError(err);
	}
}

/**
 * Compose the human-readable confirmation message for a push that requires acking,
 * delegate to the supplied yes/no prompt, and return whether the user confirmed.
 *
 * Both reasons (protected branch + override updates) collapse into a single prompt
 * when both apply.
 */
async function confirmPushChanges(
	context: PushConfirmContext,
	deps: { confirmPrompt: (message: string) => Promise<boolean> },
): Promise<boolean> {
	const lines: string[] = [];
	if (context.protectedBranch && context.overrideUpdates) {
		lines.push(
			`Branch ${JSON.stringify(context.branchName)} is protected and this push will override existing remote settings on it.`,
		);
	} else if (context.protectedBranch) {
		lines.push(
			`Branch ${JSON.stringify(context.branchName)} is protected. About to push changes to it.`,
		);
	} else if (context.overrideUpdates) {
		lines.push(
			`This push will override existing remote settings on branch ${JSON.stringify(context.branchName)}.`,
		);
	}
	lines.push("");
	lines.push("Continue? [y/N]");
	return deps.confirmPrompt(lines.join("\n"));
}

/**
 * Read a single y/n answer from stdin via `readline/promises`. Empty input or anything
 * that doesn't start with `y`/`Y` resolves to `false` so the safe default is "abort".
 *
 * When stdin isn't a TTY (CI, scripts) the prompt still works — it just reads a line
 * non-interactively. To skip the prompt entirely, pass `--update-existing` and/or
 * `--allow-protected-branch`.
 */
async function defaultConfirmPrompt(message: string): Promise<boolean> {
	const rl = createInterface({
		input: process.stdin,
		output: process.stderr,
	});
	try {
		const answer = await rl.question(`${message} `);
		return /^y(es)?$/i.test(answer.trim());
	} finally {
		rl.close();
	}
}

// ───────────────────────── branch ───────────────────────

export interface BranchCommandOptions {
	name: string;
	projectId?: string;
	orgId?: string;
	apiKey?: string;
	configPath?: string;
}

/**
 * Implementation of `neon-ts branch <name>`. Always creates a new branch from the
 * branch-policy function in `neon.ts`, updates context, and prints a summary.
 *
 * When no context file exists, the JSON suitable for writing to `.neon/project.json` is
 * included in the summary so the user can pipe it into a file themselves.
 */
export async function runBranch(
	options: BranchCommandOptions,
	ctx: CommandEnv,
): Promise<CommandResult> {
	const api = resolveApi(options.apiKey, ctx);
	if (typeof api === "string") return failure(api);

	try {
		const result = await branch({
			name: options.name,
			cwd: ctx.cwd,
			api,
			...(options.projectId ? { projectId: options.projectId } : {}),
			...(options.orgId ? { orgId: options.orgId } : {}),
			...(options.configPath ? { configPath: options.configPath } : {}),
		});

		const lines: string[] = [
			`✓ created branch ${result.branchName} (${result.branchId})`,
			`  pattern   : ${result.pattern}`,
			`  project   : ${result.projectId}${result.orgId ? ` (org ${result.orgId})` : ""}`,
			`  parent    : ${result.parentBranchName} (${result.parentBranchId})`,
		];
		if (result.expiresAt) lines.push(`  expiresAt : ${result.expiresAt}`);
		lines.push("");
		switch (result.contextFile.status) {
			case "updated":
				lines.push(
					`  updated ${result.contextFile.path} with the new branchId.`,
				);
				break;
			case "no-file":
				lines.push(
					"  no .neon/project.json (or .neon) found — write the snippet below to pin the selected branch for subsequent commands:",
					"",
					result.contextFile.json.trimEnd(),
				);
				break;
			case "write-failed":
				lines.push(
					`  ! could not update ${result.contextFile.path}: ${result.contextFile.error}`,
					"  the branch on Neon was still created; apply this snippet by hand:",
					"",
					result.contextFile.json.trimEnd(),
				);
				break;
		}
		const capturedEnvKeys = Object.keys(result.capturedEnv);
		if (capturedEnvKeys.length > 0) {
			const envPath = join(dirname(result.configPath), DEFAULT_ENV_FILE);
			const existing = existsSync(envPath)
				? readFileSync(envPath, "utf-8")
				: null;
			const writeResult = writeFileSafely(
				envPath,
				mergeEnvFile(existing, result.capturedEnv),
			);
			if (writeResult.exitCode === 0) {
				lines.push(
					`  stored Neon Auth keys in ${envPath} for future env pulls.`,
				);
			} else {
				lines.push(
					`  ! could not write Neon Auth keys to ${envPath}: ${writeResult.stderr.trim()}`,
					"  the branch on Neon was still created; add these values to your env file before they are lost:",
					"",
					mergeEnvFile(null, result.capturedEnv).trimEnd(),
				);
			}
		}
		return { exitCode: 0, stdout: `${lines.join("\n")}\n`, stderr: "" };
	} catch (err) {
		return handleError(err);
	}
}

// ─────────────────────── checkout ────────────────────────

export interface CheckoutCommandOptions {
	branch: string;
	projectId?: string;
	orgId?: string;
	apiKey?: string;
}

export async function runCheckout(
	options: CheckoutCommandOptions,
	ctx: CommandEnv,
): Promise<CommandResult> {
	const api = resolveApi(options.apiKey, ctx);
	if (typeof api === "string") return failure(api);
	try {
		const result = await checkout({
			branch: options.branch,
			cwd: ctx.cwd,
			api,
			...(options.projectId ? { projectId: options.projectId } : {}),
			...(options.orgId ? { orgId: options.orgId } : {}),
		});
		const lines = [
			`✓ checked out branch ${result.branchName} (${result.branchId})`,
			`  project   : ${result.projectId}${result.orgId ? ` (org ${result.orgId})` : ""}`,
			"",
		];
		switch (result.contextFile.status) {
			case "updated":
				lines.push(
					`  updated ${result.contextFile.path} with the new branchId.`,
				);
				break;
			case "no-file":
				lines.push(
					"  no .neon/project.json (or .neon) found — write the snippet below to pin the selected branch for subsequent commands:",
					"",
					result.contextFile.json.trimEnd(),
				);
				break;
			case "write-failed":
				lines.push(
					`  ! could not update ${result.contextFile.path}: ${result.contextFile.error}`,
					"  apply this snippet by hand:",
					"",
					result.contextFile.json.trimEnd(),
				);
				break;
		}
		return { exitCode: 0, stdout: `${lines.join("\n")}\n`, stderr: "" };
	} catch (err) {
		return handleError(err);
	}
}

// ─────────────────────── context ────────────────────────

export interface ContextCommandOptions {
	projectId?: string;
	orgId?: string;
	branch?: string;
}

/**
 * Implementation of `neon-ts context`. Prints the resolved project + branch context
 * as JSON. Pure read of {@link loadContext} — does not touch the Neon API.
 */
export function runContext(
	options: ContextCommandOptions,
	ctx: CommandEnv,
): CommandResult {
	try {
		const resolved = loadContext({
			cwd: ctx.cwd,
			...(options.projectId ? { projectId: options.projectId } : {}),
			...(options.orgId ? { orgId: options.orgId } : {}),
			...(options.branch ? { branch: options.branch } : {}),
		});
		return {
			exitCode: 0,
			stdout: `${JSON.stringify(resolved, null, 2)}\n`,
			stderr: "",
		};
	} catch (err) {
		return handleError(err);
	}
}

// ─────────────────────── status ─────────────────────────

export interface StatusCommandOptions {
	configPath?: string;
	projectId?: string;
	branch?: string;
	apiKey?: string;
}

/**
 * Implementation of `neon-ts status`. Loads `neon.ts`, computes a full push plan against
 * the live remote state via `pushConfig({ dryRun: true })`, and pretty-prints a
 * `terraform plan`-style summary of what a real `neon-ts push` *would* do.
 *
 * Never mutates anything on Neon — safe to run from CI on every PR, from pre-push hooks,
 * or just to check whether your local config has drifted.
 */
export async function runStatus(
	options: StatusCommandOptions,
	ctx: CommandEnv,
): Promise<CommandResult> {
	const api = resolveApi(options.apiKey, ctx);
	if (typeof api === "string") return failure(api);

	try {
		const result = await pushConfig({
			api,
			cwd: ctx.cwd,
			dryRun: true,
			// Pretend the caller passed `updateExisting: true` so status exposes the
			// full would-apply list as plan steps without mutating the selected branch.
			updateExisting: true,
			...(options.configPath ? { configPath: options.configPath } : {}),
			...(options.projectId ? { projectId: options.projectId } : {}),
			...(options.branch ? { branch: options.branch } : {}),
		});
		return { exitCode: 0, stdout: `${formatStatus(result)}\n`, stderr: "" };
	} catch (err) {
		return handleError(err);
	}
}

/**
 * Render a {@link PushResult} from a dry-run into a `terraform plan`-style summary.
 * Mirrors the shape `runPush` prints on a real apply so the two outputs are familiar.
 */
function formatStatus(result: Awaited<ReturnType<typeof pushConfig>>): string {
	const lines: string[] = [];
	const projectLabel = `project ${result.projectId}${result.orgId ? ` (org ${result.orgId})` : ""} branch ${result.branchName} (${result.branchId})`;
	lines.push(`Status against ${projectLabel}:`);
	lines.push("");

	const realChanges = result.applied.filter((a) => a.action !== "noop");
	if (realChanges.length === 0 && result.conflicts.length === 0) {
		lines.push("  ✓ in sync — push would be a no-op.");
		return lines.join("\n");
	}

	if (realChanges.length > 0) {
		lines.push("Plan (would apply on `neon-ts push`):");
		for (const change of realChanges) {
			const marker = change.action === "create" ? "+" : "~";
			// `service` is enabling an integration (Neon Auth, Data API) — render it as
			// "enable" rather than the underlying "create" so the diff matches the branch
			// policy mental model.
			const verb =
				change.kind === "service" && change.action === "create"
					? "enable"
					: change.action;
			lines.push(
				`  ${marker} [${change.kind}:${change.identifier}] ${verb}${formatChangeDetails(change.details)}`,
			);
		}
		lines.push("");
	}

	if (result.conflicts.length > 0) {
		lines.push("Conflicts (would block push):");
		for (const c of result.conflicts) {
			lines.push(
				`  ! [${c.kind}:${c.identifier}] ${c.field}: ${formatValue(c.current)} → ${formatValue(c.desired)}`,
			);
			lines.push(`    reason: ${c.reason}`);
		}
		lines.push("");
	}

	// Trim the trailing blank line.
	while (lines[lines.length - 1] === "") lines.pop();
	return lines.join("\n");
}

function formatChangeDetails(
	details: Record<string, unknown> | undefined,
): string {
	if (!details || Object.keys(details).length === 0) return "";
	const inline = Object.entries(details)
		.map(([k, v]) => `${k}=${formatValue(v)}`)
		.join(", ");
	return ` (${inline})`;
}

function formatValue(value: unknown): string {
	if (value === undefined || value === null) return "<unset>";
	if (typeof value === "string") return value;
	return JSON.stringify(value);
}

// ─────────────────────── env pull ───────────────────────

/** Filename `env pull` writes by default. Matches the Vercel/Next.js convention. */
const DEFAULT_ENV_FILE = ".env.local";

export interface EnvPullCommandOptions {
	/** Path to write env vars to. Defaults to `.env.local` in `cwd`. */
	file?: string;
	configPath?: string;
	projectId?: string;
	branch?: string;
	apiKey?: string;
}

/**
 * Implementation of `neon-ts env pull [file]`. Loads `neon.ts`, resolves the project +
 * branch via the standard chain (same as `loadContext` / `fetchEnv`), calls the Neon API
 * for connection strings, and merges them into `.env.local` (or the supplied filename) in
 * `KEY=value` format.
 *
 * Merge is additive — unlike `vercel env pull`, an existing file is **not** wiped. Lines
 * setting one of the Neon-managed keys are replaced in place; all other lines (comments,
 * unrelated variables pulled from another tool, etc.) are preserved verbatim. Keys not
 * already present are appended at the end. This keeps `.env.local` usable as the single
 * source of truth even when multiple tools write to it.
 */
export async function runEnvPull(
	options: EnvPullCommandOptions,
	ctx: CommandEnv,
): Promise<CommandResult> {
	const api = resolveApi(options.apiKey, ctx);
	if (typeof api === "string") return failure(api);

	try {
		const explicitTargetPath = options.file
			? resolveEnvFilePath(options.file, ctx.cwd)
			: undefined;
		const { env, defaultEnvPath } = await loadConfigAndFetchEnv(
			options,
			ctx,
			api,
			explicitTargetPath,
		);
		const targetPath = explicitTargetPath ?? defaultEnvPath;
		const existing = existsSync(targetPath)
			? readFileSync(targetPath, "utf-8")
			: null;
		return writeFileSafely(
			targetPath,
			mergeEnvFile(existing, neonEnvToProcessEnv(env)),
		);
	} catch (err) {
		return handleError(err);
	}
}

/**
 * Merge `pairs` into an existing dotenv-style file body. Lines that assign one of the
 * keys in `pairs` (with optional leading `export `) are replaced in place; everything
 * else — comments, blank lines, unrelated variables — is kept exactly as it was. Keys
 * that didn't appear in the existing body are appended at the end.
 *
 * When the file does not yet exist (`existing === null`) the keys are written as a fresh
 * `KEY=value` block with a trailing newline.
 */
function mergeEnvFile(
	existing: string | null,
	pairs: Record<string, string>,
): string {
	if (existing === null) {
		const lines: string[] = [];
		for (const [key, value] of Object.entries(pairs)) {
			lines.push(`${key}=${escapeEnvValue(value)}`);
		}
		lines.push("");
		return lines.join("\n");
	}

	const remaining = new Map(Object.entries(pairs));
	const sourceLines = existing.split("\n");
	// `split("\n")` on a body ending in "\n" yields a trailing "" we have to track so we
	// can put it back when re-joining (and so we don't accidentally treat it as a real
	// line during the replace pass).
	const hadTrailingNewline = existing.length > 0 && existing.endsWith("\n");
	const lines = hadTrailingNewline
		? sourceLines.slice(0, -1)
		: sourceLines.slice();

	const out: string[] = [];
	for (const line of lines) {
		const key = matchEnvKey(line);
		if (key !== null && remaining.has(key)) {
			const value = remaining.get(key) as string;
			out.push(`${key}=${escapeEnvValue(value)}`);
			remaining.delete(key);
		} else {
			out.push(line);
		}
	}

	if (remaining.size > 0) {
		// Make sure the appended block is separated from prior content by a blank line
		// when the file already had any non-blank content.
		if (out.length > 0 && out[out.length - 1] !== "") out.push("");
		for (const [key, value] of remaining) {
			out.push(`${key}=${escapeEnvValue(value)}`);
		}
	}

	out.push("");
	return out.join("\n");
}

/**
 * Return the variable name assigned by a single dotenv line (e.g. `FOO=bar` ->`FOO`,
 * `export FOO=bar` -> `FOO`), or `null` for comments / blanks / non-assignments. Quoting
 * around the value is ignored — we only need to identify the key for replacement.
 */
function matchEnvKey(line: string): string | null {
	const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
	return match ? (match[1] ?? null) : null;
}

function parseEnvFile(body: string): NodeJS.ProcessEnv {
	const out: NodeJS.ProcessEnv = {};
	for (const line of body.split("\n")) {
		const parsed = parseEnvLine(line);
		if (parsed) out[parsed.key] = parsed.value;
	}
	return out;
}

function parseEnvLine(line: string): { key: string; value: string } | null {
	const match = line.match(
		/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/,
	);
	const key = match?.[1];
	const rawValue = match?.[2];
	if (key === undefined || rawValue === undefined) return null;
	return { key, value: unescapeEnvValue(rawValue.trim()) };
}

/**
 * Quote env-var values that contain characters which would otherwise break the
 * `KEY=value` parse (`#` for comments, leading/trailing whitespace, embedded quotes).
 * Postgres URIs typically need quoting because of `?` query strings and `=` in params.
 */
function escapeEnvValue(value: string): string {
	if (/^[A-Za-z0-9_./:@-]*$/.test(value)) return value;
	const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
	return `"${escaped}"`;
}

function unescapeEnvValue(value: string): string {
	if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
		return value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
	}
	if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
		return value.slice(1, -1);
	}
	return value;
}

function resolveEnvFilePath(file: string, cwd: string): string {
	return file.startsWith("/") ? file : join(cwd, file);
}

// ─────────────────────── env run ────────────────────────

export interface EnvRunCommandOptions {
	/** The user command to spawn (after `--`). The first element is the executable. */
	command: string[];
	configPath?: string;
	projectId?: string;
	branch?: string;
	apiKey?: string;
}

/**
 * Implementation of `neon-ts env run -- <cmd...>`. Fetches the env from Neon, then
 * spawns the user-supplied command with the env vars injected on top of the inherited
 * `process.env`. Stdio is inherited so interactive dev servers (with their colors and
 * prompts) keep working. The parent process exits with the child's exit code.
 *
 * Returns a `CommandResult` with `exitCode` set to the child's code on success, or to a
 * non-zero code with a populated `stderr` when the fetch itself failed (in which case
 * the child is never spawned).
 */
export async function runEnvRun(
	options: EnvRunCommandOptions,
	ctx: CommandEnv,
): Promise<CommandResult> {
	if (options.command.length === 0) {
		return failure(
			[
				"`env run` requires a command to spawn.",
				"Usage: neon-ts env run -- <command> [args...]",
				"Example: neon-ts env run -- npm run dev",
			].join("\n"),
		);
	}

	const api = resolveApi(options.apiKey, ctx);
	if (typeof api === "string") return failure(api);

	let injected: Record<string, string>;
	try {
		const { env } = await loadConfigAndFetchEnv(options, ctx, api);
		injected = neonEnvToProcessEnv(env);
	} catch (err) {
		return handleError(err);
	}

	const [executable, ...args] = options.command;
	const exitCode = await spawnAndWait(executable, args, {
		cwd: ctx.cwd,
		env: { ...process.env, ...injected },
	});
	return { exitCode, stdout: "", stderr: "" };
}

/**
 * Spawn a child process with stdio inherited so dev servers stay interactive. Resolves
 * with the child's exit code (treating signal terminations as code 1 so the CLI surfaces
 * a non-zero exit consistently).
 */
function spawnAndWait(
	command: string,
	args: string[],
	options: { cwd: string; env: Record<string, string | undefined> },
): Promise<number> {
	return new Promise((resolve) => {
		const child = spawn(command, args, {
			cwd: options.cwd,
			env: options.env,
			stdio: "inherit",
		});
		child.on("error", (err) => {
			process.stderr.write(
				`neon-ts env run: failed to spawn '${command}': ${err.message}\n`,
			);
			resolve(1);
		});
		child.on("exit", (code, signal) => {
			if (typeof code === "number") {
				resolve(code);
				return;
			}
			if (signal) {
				process.stderr.write(
					`neon-ts env run: child terminated by signal ${signal}\n`,
				);
				resolve(1);
				return;
			}
			resolve(1);
		});
	});
}

// ───────────────────────── helpers ──────────────────────

/**
 * Shared preamble for `env pull` / `env run`: load `neon.ts`, then call `fetchEnv` with
 * the standard option-passthrough shape. Extracts the boilerplate so each top-level
 * handler stays focused on what to do with the env, not how to get it.
 */
async function loadConfigAndFetchEnv(
	options: {
		configPath?: string;
		projectId?: string;
		branch?: string;
	},
	ctx: CommandEnv,
	api: NeonApi,
	envFilePath?: string,
): Promise<{
	env: Awaited<ReturnType<typeof fetchEnv>>;
	configPath: string;
	defaultEnvPath: string;
}> {
	const { config, resolvedPath } = await loadConfigFromFile({
		...(options.configPath ? { path: options.configPath } : {}),
		cwd: ctx.cwd,
	});
	const defaultEnvPath = join(dirname(resolvedPath), DEFAULT_ENV_FILE);
	const envFileSource = envFilePath ?? defaultEnvPath;
	const fileEnv = existsSync(envFileSource)
		? parseEnvFile(readFileSync(envFileSource, "utf-8"))
		: {};
	const env = await fetchEnv(config, {
		api,
		cwd: ctx.cwd,
		env: { ...process.env, ...fileEnv },
		...(options.projectId ? { projectId: options.projectId } : {}),
		...(options.branch ? { branch: options.branch } : {}),
	});
	return { env, configPath: resolvedPath, defaultEnvPath };
}

/**
 * Write `body` to `targetPath`, returning a `CommandResult` with `Created` or `Updated`
 * status depending on whether the file already existed — or a clean exit-1 with a
 * helpful message when the write failed (read-only FS, EACCES, missing parent dir).
 */
function formatInitInstallMessage(
	installResult: EnsurePlatformPackageResult,
): string {
	if (installResult.installed) {
		return `✓ ${installResult.message}\n`;
	}
	if (installResult.skipped && installResult.packageRoot) {
		return `• ${installResult.message}\n`;
	}
	if (installResult.skipped) {
		return `! ${installResult.message}\n`;
	}
	return "";
}

function writeFileSafely(targetPath: string, body: string): CommandResult {
	const existed = existsSync(targetPath);
	try {
		writeFileSync(targetPath, body, "utf-8");
	} catch (writeErr) {
		const message =
			writeErr instanceof Error ? writeErr.message : String(writeErr);
		return {
			exitCode: 1,
			stdout: "",
			stderr: `Failed to write ${targetPath}: ${message}\n`,
			...(writeErr instanceof Error && writeErr.stack
				? { debugInfo: writeErr.stack }
				: {}),
		};
	}
	const verb = existed ? "Updated" : "Created";
	return {
		exitCode: 0,
		stdout: `✓ ${verb} ${targetPath}\n`,
		stderr: "",
	};
}

function resolveApi(
	apiKeyOption: string | undefined,
	ctx: CommandEnv,
): NeonApi | string {
	if (ctx.api) return ctx.api;
	const resolved = resolveApiKey(
		apiKeyOption ? { apiKey: apiKeyOption } : {},
	);
	if (!resolved) {
		return [
			"Missing Neon API key.",
			"Tried (in order): --api-key, NEON_API_KEY env, and ~/.config/neonctl/credentials.json.",
			"Either pass --api-key, set NEON_API_KEY (or put it in a .env file), or run `npx neonctl auth` to populate the credentials file.",
			"Generate a key at https://console.neon.tech/app/settings/api-keys.",
		].join("\n");
	}
	return createRealNeonApi({ apiKey: resolved.token });
}

/**
 * Stable exit code per `PlatformError` code. Mirrors the table in README → "CLI" so shell
 * pipelines and CI can branch on the specific failure mode without parsing free text. Any
 * `PlatformError` whose code is not listed here falls through to exit 5 (generic
 * `PlatformError`) with the code prepended to the message.
 */
const EXIT_CODE_BY_PLATFORM_ERROR_CODE: Readonly<Record<string, number>> = {
	[ErrorCode.MissingApiKey]: 1,
	[ErrorCode.Unauthorized]: 6,
	[ErrorCode.Forbidden]: 7,
	[ErrorCode.NotFound]: 8,
	[ErrorCode.RateLimited]: 9,
	[ErrorCode.NetworkError]: 10,
	[ErrorCode.ServerError]: 11,
	[ErrorCode.Locked]: 11,
	[ErrorCode.InternalError]: 99,
};

/**
 * Map every error class / code to a stable exit code so shell pipelines and CI can branch
 * on the specific failure mode without parsing free text. See README → "CLI" for the full
 * table.
 */
function handleError(err: unknown): CommandResult {
	if (err instanceof PushAbortedError)
		return errorResult(err, err.message, 12);
	if (err instanceof PushConflictError)
		return errorResult(err, err.message, 2);
	if (err instanceof MissingContextError)
		return errorResult(err, `Missing context: ${err.message}`, 3);
	if (err instanceof ConfigLoadError)
		return errorResult(err, `Failed to load config: ${err.message}`, 4);
	if (err instanceof PlatformError) {
		const exitCode = EXIT_CODE_BY_PLATFORM_ERROR_CODE[err.code];
		if (exitCode !== undefined)
			return errorResult(err, err.message, exitCode);
		return errorResult(err, `[${err.code}] ${err.message}`, 5);
	}
	if (err instanceof Error) return errorResult(err, err.message, 1);
	return failure(String(err), 1);
}

function errorResult(
	err: unknown,
	message: string,
	exitCode: number,
): CommandResult {
	const result: CommandResult = {
		exitCode,
		stdout: "",
		stderr: `${message}\n`,
	};
	const debug = buildDebugInfo(err);
	if (debug) result.debugInfo = debug;
	return result;
}

function buildDebugInfo(err: unknown): string | undefined {
	if (!(err instanceof Error)) return undefined;
	const lines: string[] = [];
	if (err instanceof PlatformError) {
		lines.push(`code     : ${err.code}`);
		if (Object.keys(err.details).length > 0) {
			lines.push(`details  : ${JSON.stringify(err.details, null, 2)}`);
		}
	}
	if (err.cause instanceof Error) {
		lines.push(`cause    : ${err.cause.name}: ${err.cause.message}`);
	}
	if (err.stack) {
		lines.push(err.stack);
	}
	return lines.length > 0 ? lines.join("\n") : undefined;
}

function failure(message: string, exitCode = 1): CommandResult {
	return { exitCode, stdout: "", stderr: `${message}\n` };
}
