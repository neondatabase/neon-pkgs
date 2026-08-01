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
 * - `PLATFORM_PARTIAL_BRANCH_CREATE` — `createBranch` created the branch but failed to
 *   apply its policy, so the branch exists without its declared settings.
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
	PushAborted: "PLATFORM_PUSH_ABORTED",
	ConfigLoadFailed: "PLATFORM_CONFIG_LOAD_FAILED",
	MissingApiKey: "PLATFORM_MISSING_API_KEY",
	AmbiguousBranchAuth: "PLATFORM_AMBIGUOUS_BRANCH_AUTH",
	BranchNotFound: "PLATFORM_BRANCH_NOT_FOUND",
	FeatureUnavailable: "PLATFORM_FEATURE_UNAVAILABLE",
	MissingParentBranch: "PLATFORM_MISSING_PARENT_BRANCH",
	PartialBranchCreate: "PLATFORM_PARTIAL_BRANCH_CREATE",
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
 * Base class for all errors thrown by `@neon/config`. Always extend this so callers
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
 * Structural check for a {@link PlatformError}.
 *
 * Prefer this over a bare `instanceof PlatformError` whenever the error may have crossed a
 * module-realm boundary. A `neon.ts` loaded through jiti imports its *own* copy of this
 * package, so a `PlatformError` thrown while evaluating it has a different class identity
 * than ours and fails `instanceof` — but its stable string `code` (always prefixed
 * `PLATFORM_`) survives the boundary intact, which is what we match on here.
 */
export function isPlatformError(value: unknown): value is PlatformError {
	if (value instanceof PlatformError) return true;
	if (typeof value !== "object" || value === null) return false;
	if (!("code" in value)) return false;
	const { code } = value;
	return typeof code === "string" && code.startsWith("PLATFORM_");
}

/**
 * Append a "report-a-bug" footer to an error message. Used only on truly unreachable
 * internal errors — never on user-facing validation / configuration errors where the user
 * is supposed to fix something on their end.
 */
export function bugReportFooter(): string {
	return `\nThis indicates a bug in @neon/config. Please file an issue: ${ISSUE_URL}`;
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
			`Invalid Neon config:\n  - ${issues.join("\n  - ")}`,
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
 * Thrown by {@link pushConfig} when the caller-supplied `confirm` callback declines a
 * push that requires confirmation (protected branch and/or mutable drift overriding
 * existing remote settings).
 *
 * The CLI maps this to a non-zero exit so users see "aborted" rather than a stack trace.
 */
export class PushAbortedError extends PlatformError {
	override readonly name = "PushAbortedError";
	readonly branchName: string;
	readonly reasons: readonly ("protected-branch" | "override-updates")[];

	constructor(
		branchName: string,
		reasons: readonly ("protected-branch" | "override-updates")[],
	) {
		super(
			"PLATFORM_PUSH_ABORTED",
			[
				`Aborted push to branch ${JSON.stringify(branchName)}.`,
				reasons.length > 0
					? `Reason${reasons.length === 1 ? "" : "s"}: ${reasons.join(", ")}.`
					: undefined,
				"Re-run with `--update-existing` (override existing settings) or `--allow-protected-branch` (push to a protected branch) to skip the prompt.",
			]
				.filter(Boolean)
				.join(" "),
			{ details: { branchName, reasons: [...reasons] } },
		);
		this.branchName = branchName;
		this.reasons = reasons;
	}
}

/**
 * Thrown by `createBranch` when the branch was created but pushing its `neon.ts` policy onto
 * it failed — e.g. the API rejected a declared compute setting, or a service could not be
 * provisioned. The branch is **real**: it exists with its creation-time `parent` but without
 * the rest of its declared settings.
 *
 * The created branch's id/name are carried on the error so callers can keep it usable (pin it,
 * report it) instead of leaving a branch behind that no one knows diverges from the policy.
 * Nothing re-applies a policy to an *existing* branch implicitly, so recovering takes an
 * explicit apply with `updateExisting: true` (SDK) / `--update-existing` (CLI).
 */
export class PartialBranchCreateError extends PlatformError {
	override readonly name = "PartialBranchCreateError";
	readonly branchId: string;
	readonly branchName: string;
	/**
	 * Why the policy failed, taken from the underlying error — what Neon actually rejected.
	 * Exposed separately from {@link message} so a caller that has already reported the created
	 * branch can show just the reason.
	 */
	readonly reason: string;

	constructor(branchId: string, branchName: string, cause: unknown) {
		const reason = messageOf(cause);
		super(
			"PLATFORM_PARTIAL_BRANCH_CREATE",
			[
				`Created branch ${JSON.stringify(branchName)} (${branchId}), but applying the neon.ts policy to it failed: ${reason}`,
				"The branch exists and is usable, but its settings do not match the policy. Fix the cause above, then apply the policy to the existing branch with `updateExisting: true` (SDK) / `--update-existing` (CLI).",
			].join("\n"),
			{ cause, details: { branchId, branchName } },
		);
		this.branchId = branchId;
		this.branchName = branchName;
		this.reason = reason;
	}
}

/**
 * Structural check for a {@link PartialBranchCreateError}, matching on the stable `code` and
 * the branch fields rather than class identity — same realm-crossing rationale as
 * {@link isPlatformError}.
 */
export function isPartialBranchCreateError(
	value: unknown,
): value is PartialBranchCreateError {
	if (value instanceof PartialBranchCreateError) return true;
	if (!isPlatformError(value)) return false;
	if (value.code !== ErrorCode.PartialBranchCreate) return false;
	return (
		"branchId" in value &&
		typeof value.branchId === "string" &&
		"branchName" in value &&
		typeof value.branchName === "string" &&
		"reason" in value &&
		typeof value.reason === "string"
	);
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

function messageOf(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause);
}

function formatValue(value: unknown): string {
	if (value === undefined) return "<unset>";
	if (typeof value === "string") return JSON.stringify(value);
	if (typeof value === "object" && value !== null)
		return JSON.stringify(value);
	return String(value);
}
