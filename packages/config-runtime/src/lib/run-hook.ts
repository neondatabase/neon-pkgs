import { spawn } from "node:child_process";
import type { Hook, ShellHook } from "@neondatabase/config";

/**
 * Thrown when a **shell-command** hook exits non-zero (or fails to spawn). Function hooks
 * surface their own thrown errors directly; this wraps the process-level failure with the
 * offending command and exit code so the CLI can report which hook step failed.
 */
export class HookExecutionError extends Error {
	readonly command: string;
	readonly exitCode: number | null;
	readonly signal: NodeJS.Signals | null;

	constructor(
		command: string,
		exitCode: number | null,
		signal: NodeJS.Signals | null,
		cause?: unknown,
	) {
		const how =
			signal !== null
				? `was killed by signal ${signal}`
				: `exited with code ${exitCode ?? "unknown"}`;
		super(`Hook command failed (${how}): ${command}`, { cause });
		this.name = "HookExecutionError";
		this.command = command;
		this.exitCode = exitCode;
		this.signal = signal;
	}
}

/** Options controlling how a hook (specifically its shell-command form) is executed. */
export interface RunHookOptions {
	/** Working directory for shell-command hooks. Defaults to `process.cwd()`. */
	cwd?: string;
	/**
	 * Extra environment variables injected into shell-command hooks (e.g. `DATABASE_URL`),
	 * merged over `process.env`. Ignored by function hooks (they receive the typed context).
	 */
	env?: Record<string, string | undefined>;
	/** Receives stdout/stderr chunks from shell-command hooks as they stream. */
	onOutput?: (chunk: string) => void;
}

/**
 * Run a lifecycle hook and return its result.
 *
 * - **Function hook** — awaited and its value returned (e.g. a `checkout.before` rename).
 * - **Shell-command hook** — each command run sequentially and **non-interactively** (stdin
 *   is not attached and `CI=1` is set, so an accidental interactive command like
 *   `drizzle-kit push` fails fast instead of hanging). Returns `undefined` (shell hooks have
 *   no return channel). A non-zero exit throws {@link HookExecutionError} and stops the chain.
 * - **`undefined`** — no hook configured; returns `undefined`.
 *
 * The caller decides semantics: for `before` hooks, propagate a throw to abort the operation;
 * for `after` hooks, observe (and typically degrade a failure to a warning, since the branch
 * already changed).
 */
export async function runHook<Ctx, Result>(
	hook: Hook<Ctx, Result> | undefined,
	ctx: Ctx,
	options: RunHookOptions = {},
): Promise<Result | undefined> {
	if (hook === undefined) return undefined;
	if (typeof hook === "function") {
		return await hook(ctx);
	}
	await runShellHook(hook, options);
	return undefined;
}

/**
 * Run a {@link ShellHook} (one command or a sequential list) non-interactively. Exposed for
 * callers that already know a hook is shell-shaped, or that want to run ad-hoc command chains
 * with Neon env injected. Throws {@link HookExecutionError} on the first non-zero exit.
 */
export async function runShellHook(
	hook: ShellHook,
	options: RunHookOptions = {},
): Promise<void> {
	const commands = Array.isArray(hook) ? hook : [hook];
	for (const command of commands) {
		await runOneCommand(command, options);
	}
}

function runOneCommand(
	command: string,
	options: RunHookOptions,
): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		const child = spawn(command, {
			shell: true,
			cwd: options.cwd ?? process.cwd(),
			// stdin is intentionally NOT inherited: hooks must be non-interactive so a stray
			// prompt (e.g. `drizzle-kit push`) fails fast in CI instead of hanging forever.
			stdio: ["ignore", "pipe", "pipe"],
			env: buildEnv(options.env),
		});

		child.stdout?.on("data", (chunk: Buffer) =>
			options.onOutput?.(chunk.toString()),
		);
		child.stderr?.on("data", (chunk: Buffer) =>
			options.onOutput?.(chunk.toString()),
		);
		child.on("error", (cause) => {
			reject(new HookExecutionError(command, null, null, cause));
		});
		child.on("close", (code, signal) => {
			if (code === 0) {
				resolve();
				return;
			}
			reject(new HookExecutionError(command, code, signal));
		});
	});
}

/**
 * Build the child env: `process.env` + a forced `CI=1` (so tools default to non-interactive)
 * + the caller's overrides, dropping any `undefined` values so they don't shadow real vars.
 */
function buildEnv(
	extra: Record<string, string | undefined> | undefined,
): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...process.env, CI: "1" };
	if (extra) {
		for (const [key, value] of Object.entries(extra)) {
			if (value !== undefined) env[key] = value;
		}
	}
	return env;
}
