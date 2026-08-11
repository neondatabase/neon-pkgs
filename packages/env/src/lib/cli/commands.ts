import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
	ConfigLoadError,
	ErrorCode,
	loadConfigFromFile,
	MissingContextError,
	type NeonApi,
	PlatformError,
} from "@neon/config/v1";
import { fetchEnvReusingSecrets } from "@neon-internals/env-core/reuse-secrets";
import { resolveApiKey } from "./resolve-api-key.js";
import { resolveContext } from "./resolve-context.js";

/** File `env run` reads to layer one-time auth keys. Matches the Vercel/Next.js convention. */
const DEFAULT_ENV_FILE = ".env.local";

/**
 * Cross-cutting environment a CLI command is allowed to touch. Injected so tests can drive
 * the handler with a custom NeonApi and a controlled `cwd` without spawning child
 * processes.
 */
export interface CommandEnv {
	cwd: string;
	/**
	 * When set, used directly as the NeonApi. When omitted, the real adapter is built from
	 * the key {@link resolveApiKey} resolves (`--api-key` → `NEON_API_KEY` → the Neon CLI's
	 * stored credentials).
	 */
	api?: NeonApi;
}

export interface CommandResult {
	/** Process exit code. `0` for success, non-zero for failure. */
	exitCode: number;
	/** Text intended for stdout. */
	stdout: string;
	/** Text intended for stderr (human-readable status / error messages). */
	stderr: string;
	/** Optional structured debug payload — printed only when `--debug` is passed. */
	debugInfo?: string;
}

/**
 * Inputs needed to resolve a branch and fetch its env, shared by `run` and `export`: an
 * optional explicit `neon.ts` path, project/branch overrides, and an API key. Everything
 * ambient — `.neon`, `NEON_*` env, the Neon CLI's stored credentials — is resolved by the
 * CLI (see `resolveContext` and `resolveApiKey`), never by the library.
 */
export interface EnvResolveOptions {
	configPath?: string;
	projectId?: string;
	branch?: string;
	apiKey?: string;
	/** Neon CLI profile whose stored credential to use. `--profile`, else `NEON_PROFILE`. */
	profile?: string;
}

export interface EnvRunCommandOptions extends EnvResolveOptions {
	/** The user command to spawn (after `--`). The first element is the executable. */
	command: string[];
}

/**
 * Implementation of `neon-env run -- <cmd...>`. Loads `neon.ts`, fetches the env from
 * Neon, then spawns the user-supplied command with the env vars injected on top of the
 * inherited `process.env`. Stdio is inherited so interactive dev servers keep working.
 * The parent process exits with the child's exit code.
 */
export async function runEnvRun(
	options: EnvRunCommandOptions,
	ctx: CommandEnv,
): Promise<CommandResult> {
	if (options.command.length === 0) {
		return failure(
			[
				"`env run` requires a command to spawn.",
				"Usage: neon-env run -- <command> [args...]",
				"Example: neon-env run -- npm run dev",
			].join("\n"),
		);
	}

	// The CLI owns project/branch resolution (flags → NEON_* env → .neon file) so the
	// library functions stay filesystem/env-agnostic.
	const resolved = resolveContext({
		cwd: ctx.cwd,
		...(options.projectId ? { projectId: options.projectId } : {}),
		...(options.branch ? { branch: options.branch } : {}),
	});
	if (!resolved.ok) {
		return failure(
			[
				"`env run` could not resolve the Neon project and branch:",
				...resolved.missing.map((m) => `  - ${m}`),
			].join("\n"),
			3,
		);
	}

	let injected: Record<string, string>;
	try {
		injected = await loadConfigAndFetchEnv(options, ctx, resolved.context);
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

export interface EnvExportCommandOptions extends EnvResolveOptions {
	/** Output format. `dotenv` (KEY=value lines) by default; `json` for tooling / bulk loaders. */
	format?: "dotenv" | "json";
}

/**
 * Implementation of `neon-env export`. Resolves the branch's Neon env the same way `run`
 * does (neon.ts policy + linked branch), then writes it to stdout — as dotenv lines or JSON —
 * instead of spawning a process, so other env tools can consume it. For example, varlock can
 * bulk-load it with `@setValuesBulk(exec("neon-env export --format json"), format=json)`.
 */
export async function runEnvExport(
	options: EnvExportCommandOptions,
	ctx: CommandEnv,
): Promise<CommandResult> {
	const resolved = resolveContext({
		cwd: ctx.cwd,
		...(options.projectId ? { projectId: options.projectId } : {}),
		...(options.branch ? { branch: options.branch } : {}),
	});
	if (!resolved.ok) {
		return failure(
			[
				"`env export` could not resolve the Neon project and branch:",
				...resolved.missing.map((m) => `  - ${m}`),
			].join("\n"),
			3,
		);
	}

	let entries: Record<string, string>;
	try {
		entries = await loadConfigAndFetchEnv(options, ctx, resolved.context);
	} catch (err) {
		return handleError(err);
	}

	const stdout =
		options.format === "json"
			? `${JSON.stringify(entries, null, 2)}\n`
			: toDotenv(entries);
	return { exitCode: 0, stdout, stderr: "" };
}

/** Render an env map as dotenv `KEY=value` lines, quoting values that need it. */
function toDotenv(entries: Record<string, string>): string {
	const lines = Object.entries(entries).map(([key, value]) =>
		formatDotenvLine(key, value),
	);
	return lines.length > 0 ? `${lines.join("\n")}\n` : "";
}

/**
 * Render a single `KEY=value` dotenv line, double-quoting (and escaping) values that contain
 * whitespace, `#`, quotes, or `=` so connection strings round-trip through dotenv parsers.
 */
function formatDotenvLine(key: string, value: string): string {
	if (!/[\s#"'=]/.test(value)) return `${key}=${value}`;
	const escaped = value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
	return `${key}="${escaped}"`;
}

/**
 * Load `neon.ts`, then resolve the branch env for the explicitly-resolved project + branch.
 * Layers `.env.local` (next to the config file) into the env source so re-runs keep the
 * one-time secrets the Neon API only returns once — the branch credential's, and any Auth
 * values a pre-`base_url` integration can no longer report. Uses
 * {@link fetchEnvReusingSecrets} rather than a bare `fetchEnv` so a run that already has a
 * working credential verifies and keeps it instead of minting another one per invocation.
 */
async function loadConfigAndFetchEnv(
	options: EnvResolveOptions,
	ctx: CommandEnv,
	resolved: { projectId: string; branch: string },
): Promise<Record<string, string>> {
	const { config, resolvedPath } = await loadConfigFromFile({
		...(options.configPath ? { path: options.configPath } : {}),
		cwd: ctx.cwd,
	});
	const envFileSource = join(dirname(resolvedPath), DEFAULT_ENV_FILE);
	const fileEnv = existsSync(envFileSource)
		? parseEnvFile(readFileSync(envFileSource, "utf-8"))
		: {};
	const apiKey = resolveApiKey({
		...(options.apiKey ? { apiKey: options.apiKey } : {}),
		...(options.profile ? { profile: options.profile } : {}),
	});
	const { vars } = await fetchEnvReusingSecrets(config, {
		projectId: resolved.projectId,
		branch: resolved.branch,
		env: { ...process.env, ...fileEnv },
		...(ctx.api ? { api: ctx.api } : {}),
		...(apiKey ? { apiKey } : {}),
	});
	return vars;
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
				`neon-env run: failed to spawn '${command}': ${err.message}\n`,
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
					`neon-env run: child terminated by signal ${signal}\n`,
				);
				resolve(1);
				return;
			}
			resolve(1);
		});
	});
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

function unescapeEnvValue(value: string): string {
	if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
		return value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, "\\");
	}
	if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
		return value.slice(1, -1);
	}
	return value;
}

/**
 * Stable exit code per `PlatformError` code. Mirrors the table in the config package so
 * shell pipelines can branch on the specific failure mode without parsing free text.
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

function handleError(err: unknown): CommandResult {
	if (err instanceof MissingContextError)
		return errorResult(err, `Missing context: ${err.message}`, 3);
	if (err instanceof ConfigLoadError)
		return errorResult(err, `Failed to load config: ${err.message}`, 4);
	// The library's own wording is right for a library ("this package never reads
	// NEON_API_KEY on your behalf") and wrong here: `neon-env` does read it. Render the
	// chain this CLI actually implements, the same way an unresolved context is rendered.
	if (err instanceof PlatformError && err.code === ErrorCode.MissingApiKey) {
		return errorResult(
			err,
			[
				"No Neon API key. `neon-env` looks for one in this order:",
				"  - the `--api-key` flag",
				"  - the `NEON_API_KEY` environment variable",
				"  - `credentials.json` in `NEONCTL_CONFIG_DIR` (else `~/.config/neonctl`) — run `neon auth` to create it",
			].join("\n"),
			EXIT_CODE_BY_PLATFORM_ERROR_CODE[ErrorCode.MissingApiKey] ?? 1,
		);
	}
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
