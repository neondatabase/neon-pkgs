import type { ConflictReport } from "./types.js";

/**
 * Base class for all errors thrown by `@neondatabase/platform`. Always extend this so callers
 * can catch every package-thrown error with a single `instanceof` check.
 */
export class PlatformError extends Error {
	override readonly name: string = "PlatformError";
	readonly code: string;

	constructor(code: string, message: string, options?: { cause?: unknown }) {
		super(message, options);
		this.code = code;
	}
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
 * Thrown when {@link pushConfig} (without `applyChanges`) detects differences between the
 * local config and the remote project.
 */
export class PushConflictError extends PlatformError {
	override readonly name = "PushConflictError";
	readonly conflicts: readonly ConflictReport[];

	constructor(conflicts: readonly ConflictReport[]) {
		super(
			"PLATFORM_PUSH_CONFLICT",
			[
				"pushConfig refused to apply because local config conflicts with remote state.",
				"Pass `applyChanges: true` (SDK) or `--apply-changes` (CLI) to force-apply.",
				"",
				...conflicts.map(
					(c) =>
						`  - [${c.kind}:${c.identifier}] ${c.field}: ${c.reason} (current=${formatValue(c.current)}, desired=${formatValue(c.desired)})`,
				),
			].join("\n"),
		);
		this.conflicts = conflicts;
	}
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
