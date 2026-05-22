import { resolveApiKey } from "../auth.js";
import {
	ConfigLoadError,
	ErrorCode,
	MissingContextError,
	PlatformError,
	PushConflictError,
} from "../errors.js";
import { loadContext } from "../load-context.js";
import type { NeonApi } from "../neon-api.js";
import { createRealNeonApi } from "../neon-api-real.js";
import { pullConfig } from "../pull-config.js";
import { type PushConfigOptions, pushConfig } from "../push-config.js";
import {
	formatConfigAsJson,
	formatConfigAsTypeScript,
	type PullOutputFormat,
} from "./format.js";

/**
 * Cross-cutting environment a CLI command is allowed to touch. Injected so tests can drive
 * the handlers with a `FakeNeonApi` and a controlled cwd / env without spawning child
 * processes or stubbing `process.*`.
 */
export interface CommandEnv {
	cwd: string;
	env: Record<string, string | undefined>;
	/**
	 * When set, used directly as the NeonApi. When omitted, a real adapter is constructed
	 * from `options.apiKey ?? env.NEON_API_KEY`.
	 */
	api?: NeonApi;
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
	orgId?: string;
	apiKey?: string;
	format?: PullOutputFormat;
}

/**
 * Implementation of `neon-ts pull`. Pulls the live Neon project state and prints
 * it either as a `neon.ts` snippet (default) or as JSON.
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
			...(options.orgId ? { orgId: options.orgId } : {}),
		});
		const format = options.format ?? "ts";
		const stdout =
			format === "json"
				? formatConfigAsJson(config)
				: formatConfigAsTypeScript(config);
		return { exitCode: 0, stdout, stderr: "" };
	} catch (err) {
		return handleError(err);
	}
}

// ───────────────────────── push ─────────────────────────

export interface PushCommandOptions {
	configPath?: string;
	projectId?: string;
	orgId?: string;
	apiKey?: string;
	applyChanges?: boolean;
	updateExisting?: boolean;
	applyExisting?: boolean;
}

/**
 * Implementation of `neon-ts push`. Loads `neon.ts` (or the path supplied via
 * `--config`), pushes against the resolved project, and prints a human-readable summary
 * of what changed (or what would change).
 */
export async function runPush(
	options: PushCommandOptions,
	ctx: CommandEnv,
): Promise<CommandResult> {
	const api = resolveApi(options.apiKey, ctx);
	if (typeof api === "string") return failure(api);

	const pushOptions: PushConfigOptions = {
		api,
		cwd: ctx.cwd,
		...(options.configPath ? { configPath: options.configPath } : {}),
		...(options.projectId ? { projectId: options.projectId } : {}),
		...(options.orgId ? { orgId: options.orgId } : {}),
		...(options.applyChanges ? { applyChanges: true } : {}),
		...(options.updateExisting ? { updateExisting: true } : {}),
		...(options.applyExisting ? { applyExisting: true } : {}),
	};

	try {
		const result = await pushConfig(pushOptions);
		const realChanges = result.applied.filter((c) => c.action !== "noop");
		const projectLabel = `project ${result.projectId}${result.orgId ? ` (org ${result.orgId})` : ""}`;

		const lines: string[] = [];
		if (
			realChanges.length === 0 &&
			result.conflicts.length === 0 &&
			result.skippedWildcardBranches.length === 0
		) {
			lines.push(
				`✓ ${projectLabel} is already in sync. No changes needed.`,
			);
		} else {
			lines.push(`✓ pushed config to ${projectLabel}`);
			if (realChanges.length > 0) {
				lines.push("");
				lines.push("Applied:");
				for (const change of realChanges) {
					lines.push(
						`  - [${change.kind}:${change.identifier}] ${change.action}`,
					);
				}
			}
		}
		if (result.skippedWildcardBranches.length > 0) {
			lines.push("");
			lines.push(
				"Skipped wildcard branches (pass --apply-existing to apply):",
			);
			for (const skip of result.skippedWildcardBranches) {
				lines.push(
					`  - pattern "${skip.pattern}" matched: ${skip.branches.join(", ")}`,
				);
			}
		}
		if (result.conflicts.length > 0) {
			lines.push("");
			lines.push("Conflicts (informational — applyChanges was set):");
			for (const c of result.conflicts) {
				lines.push(
					`  - [${c.kind}:${c.identifier}] ${c.field}: ${c.reason}`,
				);
			}
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
			env: ctx.env,
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

// ───────────────────────── helpers ──────────────────────

function resolveApi(
	apiKeyOption: string | undefined,
	ctx: CommandEnv,
): NeonApi | string {
	if (ctx.api) return ctx.api;
	const resolved = resolveApiKey({
		...(apiKeyOption ? { apiKey: apiKeyOption } : {}),
		env: ctx.env,
	});
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
	[ErrorCode.InsufficientScope]: 7,
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
