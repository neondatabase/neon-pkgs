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
} from "@neondatabase/config/v1";
import { fetchEnv, neonEnvToProcessEnv } from "../env.js";
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
	 * `options.apiKey ?? NEON_API_KEY` inside `fetchEnv`.
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

export interface EnvRunCommandOptions {
	/** The user command to spawn (after `--`). The first element is the executable. */
	command: string[];
	configPath?: string;
	projectId?: string;
	branch?: string;
	apiKey?: string;
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
		const env = await loadConfigAndFetchEnv(options, ctx, resolved.context);
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
 * Load `neon.ts`, then call `fetchEnv` with the explicitly-resolved project + branch.
 * Layers any one-time Auth keys from `.env.local` (next to the config file) into the env
 * source so re-runs keep round-tripping values the Neon API only returns once at
 * integration-creation time.
 */
async function loadConfigAndFetchEnv(
	options: EnvRunCommandOptions,
	ctx: CommandEnv,
	resolved: { projectId: string; branch: string },
): Promise<Awaited<ReturnType<typeof fetchEnv>>> {
	const { config, resolvedPath } = await loadConfigFromFile({
		...(options.configPath ? { path: options.configPath } : {}),
		cwd: ctx.cwd,
	});
	const envFileSource = join(dirname(resolvedPath), DEFAULT_ENV_FILE);
	const fileEnv = existsSync(envFileSource)
		? parseEnvFile(readFileSync(envFileSource, "utf-8"))
		: {};
	return fetchEnv(config, {
		projectId: resolved.projectId,
		branch: resolved.branch,
		env: { ...process.env, ...fileEnv },
		...(ctx.api ? { api: ctx.api } : {}),
		...(options.apiKey ? { apiKey: options.apiKey } : {}),
	});
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
