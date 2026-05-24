import type { ConflictReport } from "./types.js";

/**
 * Every code a {@link PlatformError} can carry. Stable identifiers — consumers can rely on
 * these for `instanceof PlatformError && err.code === ErrorCode.…` style checks instead of
 * matching on free-text messages.
 *
 * Grouped by source:
 * - `PLATFORM_INVALID_CONFIG` — `defineConfig` / `configSchema` rejected the input.
 * - `PLATFORM_MISSING_CONTEXT` — no project / branch context could be resolved.
 * - `PLATFORM_PUSH_CONFLICT` — local config conflicts with remote and the caller did not
 *   opt in to apply.
 * - `PLATFORM_CONFIG_LOAD_FAILED` — `neon.ts` could not be found or evaluated.
 * - `PLATFORM_MISSING_API_KEY` — no `NEON_API_KEY` and no explicit `apiKey` was provided.
 * - `PLATFORM_MISSING_PARENT_BRANCH` — push tried to create a child of a non-existent
 *   branch.
 * - `PLATFORM_UNAUTHORIZED` / `PLATFORM_FORBIDDEN` / `PLATFORM_NOT_FOUND` /
 *   `PLATFORM_CONFLICT` / `PLATFORM_RATE_LIMITED` / `PLATFORM_LOCKED` /
 *   `PLATFORM_SERVER_ERROR` — wrappings of Neon HTTP failures.
 * - `PLATFORM_NETWORK_ERROR` — transport-level failure (no HTTP response at all).
 * - `PLATFORM_INTERNAL_ERROR` — invariant violations. Should never happen in production;
 *   if you see one, please open an issue.
 */
export const ErrorCode = {
	InvalidConfig: "PLATFORM_INVALID_CONFIG",
	EnvNotInjected: "PLATFORM_ENV_NOT_INJECTED",
	MissingContext: "PLATFORM_MISSING_CONTEXT",
	PushConflict: "PLATFORM_PUSH_CONFLICT",
	ConfigLoadFailed: "PLATFORM_CONFIG_LOAD_FAILED",
	MissingApiKey: "PLATFORM_MISSING_API_KEY",
	AmbiguousBranchAuth: "PLATFORM_AMBIGUOUS_BRANCH_AUTH",
	BranchNotFound: "PLATFORM_BRANCH_NOT_FOUND",
	MissingParentBranch: "PLATFORM_MISSING_PARENT_BRANCH",
	Unauthorized: "PLATFORM_UNAUTHORIZED",
	Forbidden: "PLATFORM_FORBIDDEN",
	NotFound: "PLATFORM_NOT_FOUND",
	Conflict: "PLATFORM_CONFLICT",
	RateLimited: "PLATFORM_RATE_LIMITED",
	Locked: "PLATFORM_LOCKED",
	ServerError: "PLATFORM_SERVER_ERROR",
	NetworkError: "PLATFORM_NETWORK_ERROR",
	InternalError: "PLATFORM_INTERNAL_ERROR",
} as const;
export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];

const ISSUE_URL = "https://github.com/neondatabase/neon-pkgs/issues/new";

/**
 * Base class for all errors thrown by `@neondatabase/platform`. Always extend this so callers
 * can catch every package-thrown error with a single `instanceof` check.
 *
 * Optional `details` carries structured context that the CLI prints under `--debug` and
 * that programmatic consumers can read (e.g. `details.status` for HTTP wrappings,
 * `details.requestId` for Neon API failures).
 */
export class PlatformError extends Error {
	override readonly name: string = "PlatformError";
	readonly code: string;
	readonly details: Readonly<Record<string, unknown>>;

	constructor(
		code: string,
		message: string,
		options?: { cause?: unknown; details?: Record<string, unknown> },
	) {
		super(message, options);
		this.code = code;
		this.details = Object.freeze({ ...(options?.details ?? {}) });
	}
}

/**
 * Append a "report-a-bug" footer to an error message. Used only on truly unreachable
 * internal errors — never on user-facing validation / configuration errors where the user
 * is supposed to fix something on their end.
 */
export function bugReportFooter(): string {
	return `\nThis indicates a bug in @neondatabase/platform. Please file an issue: ${ISSUE_URL}`;
}

/**
 * Thrown by {@link defineConfig} when the user-provided configuration object is invalid.
 *
 * The class collects every validation failure rather than throwing on the first one so that
 * users get a complete picture of what is wrong with their `neon.ts`.
 */
export class ConfigValidationError extends PlatformError {
	override readonly name = "ConfigValidationError";
	readonly issues: readonly string[];

	constructor(issues: readonly string[]) {
		super(
			"PLATFORM_INVALID_CONFIG",
			`Invalid Neon platform config:\n  - ${issues.join("\n  - ")}`,
		);
		this.issues = issues;
	}
}

/**
 * Thrown when the package cannot resolve which Neon project to operate on.
 *
 * Per the package's read-only-filesystem contract, we never create a `.neon` context file;
 * callers must either pass `projectId`/`orgId` explicitly or rely on an existing context file
 * (`.neon/project.json` or neonctl's `.neon`).
 */
export class MissingContextError extends PlatformError {
	override readonly name = "MissingContextError";

	constructor(message: string) {
		super("PLATFORM_MISSING_CONTEXT", message);
	}
}

/**
 * Thrown by {@link pushConfig} when it detects differences between the local config and
 * the remote project that the caller hasn't opted in to apply.
 *
 * The message lists every conflict with both the current and desired value plus a
 * per-conflict hint. Mutable branch drift is applied by passing `updateExisting: true`.
 */
export class PushConflictError extends PlatformError {
	override readonly name = "PushConflictError";
	readonly conflicts: readonly ConflictReport[];

	constructor(conflicts: readonly ConflictReport[]) {
		const lines: string[] = [
			"pushConfig refused to apply: local config conflicts with remote state.",
			"",
		];
		for (const c of conflicts) {
			lines.push(
				`  - [${c.kind}:${c.identifier}] ${c.field}: ${c.reason}`,
				`      current : ${formatValue(c.current)}`,
				`      desired : ${formatValue(c.desired)}`,
				`      fix     : ${suggestFix(c)}`,
			);
		}
		const hasMutable = conflicts.some((c) => !isImmutableConflict(c));
		lines.push("");
		if (hasMutable) {
			lines.push(
				"For mutable conflicts, pass `updateExisting: true` (SDK) / `--update-existing` (CLI) to apply.",
			);
		}

		super("PLATFORM_PUSH_CONFLICT", lines.join("\n"), {
			details: { conflicts: conflicts.map((c) => ({ ...c })) },
		});
		this.conflicts = conflicts;
	}
}

function isImmutableConflict(_c: ConflictReport): boolean {
	return false;
}

function suggestFix(c: ConflictReport): string {
	if (isImmutableConflict(c)) {
		return "immutable on Neon — recreate the project, or change your `neon.ts` to match the remote.";
	}
	if (c.kind === "branch" && c.field === "parent") {
		return "create the parent branch on Neon first, or change the `parent` reference to an existing branch.";
	}
	return "pass `updateExisting: true` (SDK) / `--update-existing` (CLI) to apply.";
}

/**
 * Thrown when the SDK fails to find or load a `neon.ts` config file.
 */
export class ConfigLoadError extends PlatformError {
	override readonly name = "ConfigLoadError";

	constructor(message: string, options?: { cause?: unknown }) {
		super("PLATFORM_CONFIG_LOAD_FAILED", message, options);
	}
}

function formatValue(value: unknown): string {
	if (value === undefined) return "<unset>";
	if (typeof value === "string") return JSON.stringify(value);
	if (typeof value === "object" && value !== null)
		return JSON.stringify(value);
	return String(value);
}
