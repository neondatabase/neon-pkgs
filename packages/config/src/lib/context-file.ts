import { readFileSync, writeFileSync } from "node:fs";
import { findProjectContext } from "./context.js";
import { ConfigLoadError } from "./errors.js";

/**
 * Fields persisted in `.neon/project.json` (or the neonctl `.neon` file). Other top-level
 * keys are preserved verbatim across {@link applyContextFileFields} calls so neonctl's
 * own settings survive a `branch` mutation.
 */
export interface ContextFileFields {
	projectId: string;
	orgId?: string;
	branchId?: string;
}

/**
 * Outcome of {@link applyContextFileFields}.
 *
 * - `updated` — file rewritten in place.
 * - `write-failed` — read of the file succeeded but writing back failed (e.g. read-only
 *   filesystem, permission denied). The caller should surface `error` to the user but
 *   continue — the package never crashes a successful branch creation over an FS write
 *   error.
 */
export type ApplyContextFileResult =
	| { status: "updated" }
	| { status: "write-failed"; error: string };

/**
 * Locate the existing project-context file walking up from `cwd`. Returns the absolute
 * path of the first `.neon/project.json` found, or — failing that — the first `.neon`
 * (the neonctl convention). Returns `null` when neither exists.
 */
export function findContextFilePath(cwd: string): string | null {
	const ctx = findProjectContext({ cwd });
	return ctx?.sourcePath ?? null;
}

/**
 * Render a {@link ContextFileFields} object as a JSON string suitable for writing to
 * `.neon/project.json`. Keys are emitted in `projectId`, `orgId`, `branchId` order with a
 * trailing newline so the file looks like a normal POSIX text file. Pure function — does
 * not touch the filesystem.
 */
export function formatContextFile(fields: ContextFileFields): string {
	const ordered: Record<string, string> = { projectId: fields.projectId };
	if (fields.orgId) ordered.orgId = fields.orgId;
	if (fields.branchId) ordered.branchId = fields.branchId;
	return `${JSON.stringify(ordered, null, 2)}\n`;
}

/**
 * Merge the supplied `fields` into the JSON file at `path` and write it back in place.
 *
 * - Listed fields are overwritten when present and left untouched otherwise.
 * - Unlisted top-level keys (e.g. neonctl's own settings) are preserved verbatim.
 * - Writes use the same `JSON.stringify(_, null, 2)` formatting as
 *   {@link formatContextFile} so a `pull → branch → push` cycle stays diff-free.
 *
 * Error handling:
 * - Throws {@link ConfigLoadError} when the file is missing, unreadable, or not a JSON
 *   object — these are user-fixable problems and should fail loudly.
 * - Returns `{ status: "write-failed", error }` when the write itself fails (read-only
 *   filesystem, EACCES, etc.). The caller (typically `branch()`) reports this without
 *   crashing — the branch on Neon was already created and the JSON payload is still
 *   available for the user to apply by hand.
 */
export function applyContextFileFields(
	path: string,
	fields: ContextFileFields,
): ApplyContextFileResult {
	let raw: string;
	try {
		raw = readFileSync(path, "utf-8");
	} catch (cause) {
		throw new ConfigLoadError(
			`Failed to read context file at ${path}: ${(cause as Error)?.message ?? String(cause)}`,
			{ cause },
		);
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (cause) {
		throw new ConfigLoadError(
			[
				`Context file at ${path} is not valid JSON.`,
				`Underlying error: ${(cause as Error)?.message ?? String(cause)}`,
				"Fix the file by hand (it must be a JSON object) and re-run.",
			].join("\n"),
			{ cause },
		);
	}

	if (
		parsed === null ||
		typeof parsed !== "object" ||
		Array.isArray(parsed)
	) {
		throw new ConfigLoadError(
			`Context file at ${path} must contain a JSON object, got ${parsed === null ? "null" : Array.isArray(parsed) ? "array" : typeof parsed}.`,
		);
	}

	const merged: Record<string, unknown> = { ...parsed };
	merged.projectId = fields.projectId;
	if (fields.orgId !== undefined) merged.orgId = fields.orgId;
	if (fields.branchId !== undefined) merged.branchId = fields.branchId;

	try {
		writeFileSync(path, `${JSON.stringify(merged, null, 2)}\n`, "utf-8");
		return { status: "updated" };
	} catch (cause) {
		return {
			status: "write-failed",
			error: (cause as Error)?.message ?? String(cause),
		};
	}
}
