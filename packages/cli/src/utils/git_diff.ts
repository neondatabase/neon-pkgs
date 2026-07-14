import chalk from "chalk";
import { structuredPatch } from "diff";

/**
 * One side of a schema comparison: the branch it came from and its `CREATE …`
 * SQL. `branchName` is the friendly name (falls back to the id upstream) and
 * `branchId` the `br-…` id, so the rendered header can show both.
 */
export type BranchSchema = {
	branchName: string;
	branchId: string;
	sql: string;
};

/**
 * A single database's schema diff. `before` is the reference side (rendered as
 * `---`, the git "a/" side) and `after` is the side being reviewed (rendered as
 * `+++`, the git "b/" side). For `neon diff <branch>` the reference is the
 * branch passed in and the reviewed side is the current context branch, so `+`
 * lines are what the current branch adds on top of the reference.
 */
export type DatabaseSchemaDiff = {
	database: string;
	before: BranchSchema;
	after: BranchSchema;
};

export type RenderedDatabaseDiff = {
	database: string;
	hasChanges: boolean;
	/** The git-style unified diff, or "" when the schemas are identical. */
	text: string;
};

type Paint = (s: string) => string;

/**
 * Color palette for the rendered diff. When `color` is false every entry is the
 * identity function, so the exact same layout is emitted without ANSI codes
 * (for `--no-color`, non-TTY pipes, and stable test snapshots).
 */
const palette = (color: boolean): Record<string, Paint> => {
	const id: Paint = (s) => s;
	if (!color) {
		return {
			header: id,
			removedFile: id,
			addedFile: id,
			hunk: id,
			added: id,
			removed: id,
			noNewline: id,
		};
	}
	return {
		header: (s) => chalk.bold(s),
		removedFile: (s) => chalk.bold.red(s),
		addedFile: (s) => chalk.bold.green(s),
		hunk: (s) => chalk.cyan(s),
		added: (s) => chalk.green(s),
		removed: (s) => chalk.red(s),
		noNewline: (s) => chalk.dim(s),
	};
};

const branchLabel = (schema: BranchSchema): string =>
	`${schema.branchName} (${schema.branchId})`;

/**
 * Render a single database's schema comparison as a git-style unified diff.
 *
 * Pure: given the two schemas it computes hunks with `diff`'s `structuredPatch`
 * and lays them out like `git diff` — a bold header, red `---` / green `+++`
 * branch lines, cyan `@@` hunk headers, and green/red line bodies. Returns
 * `hasChanges: false` with empty text when the two schemas are identical.
 */
export const renderDatabaseSchemaDiff = (
	diff: DatabaseSchemaDiff,
	opts: { color: boolean },
): RenderedDatabaseDiff => {
	const patch = structuredPatch(
		diff.database,
		diff.database,
		diff.before.sql,
		diff.after.sql,
		"",
		"",
		{ context: 3 },
	);

	if (patch.hunks.length === 0) {
		return { database: diff.database, hasChanges: false, text: "" };
	}

	const paint = palette(opts.color);
	const lines: string[] = [
		paint.header(`diff --neon database ${diff.database}`),
		paint.removedFile(`--- ${branchLabel(diff.before)}`),
		paint.addedFile(`+++ ${branchLabel(diff.after)}`),
	];

	for (const hunk of patch.hunks) {
		lines.push(
			paint.hunk(
				`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
			),
		);
		for (const line of hunk.lines) {
			// `structuredPatch` prefixes every line: '+' added, '-' removed,
			// ' ' unchanged context, and '\' for the "No newline at end of file"
			// marker. Color the first three; dim the marker; leave context plain.
			if (line.startsWith("+")) {
				lines.push(paint.added(line));
			} else if (line.startsWith("-")) {
				lines.push(paint.removed(line));
			} else if (line.startsWith("\\")) {
				lines.push(paint.noNewline(line));
			} else {
				lines.push(line);
			}
		}
	}

	return {
		database: diff.database,
		hasChanges: true,
		text: lines.join("\n"),
	};
};

/**
 * Render every database's diff into one report, keeping only databases whose
 * schema actually changed. `hasChanges` is false when nothing changed across
 * all databases, letting the caller print a single "no differences" note.
 */
export const renderSchemaDiffReport = (
	diffs: DatabaseSchemaDiff[],
	opts: { color: boolean },
): { hasChanges: boolean; text: string; changedDatabases: string[] } => {
	const rendered = diffs.map((diff) => renderDatabaseSchemaDiff(diff, opts));
	const changed = rendered.filter((r) => r.hasChanges);
	return {
		hasChanges: changed.length > 0,
		text: changed.map((r) => r.text).join("\n\n"),
		changedDatabases: changed.map((r) => r.database),
	};
};
