import type { AppliedChange, ConflictReport } from "@neon/config-runtime";
import chalk from "chalk";

/**
 * A single field-level change for the settings diff. `current` is omitted when
 * there is no known "before" value (a freshly applied/planned update carries
 * only the new value — see the Phase-1 note in `reportPushResult`), in which
 * case the line renders as `field → desired` instead of `current → desired`.
 */
type FieldChange = {
	field: string;
	current?: string;
	desired: string;
};

const UNSET = "(unset)";

type Paint = (s: string) => string;

/**
 * Shared palette for the config diff, matching `neon diff`'s `git diff` styling
 * (bold headers, red "before", green "after", dim connective glyphs). When
 * `color` is false every entry is the identity function, so the identical layout
 * renders without ANSI codes for `--no-color`, non-TTY pipes, and test snapshots.
 */
const palette = (
	color: boolean,
): {
	title: Paint;
	group: Paint;
	added: Paint;
	removed: Paint;
	arrow: Paint;
} => {
	const id: Paint = (s) => s;
	if (!color) {
		return { title: id, group: id, added: id, removed: id, arrow: id };
	}
	return {
		title: (s) => chalk.bold(s),
		group: (s) => chalk.bold(s),
		added: (s) => chalk.green(s),
		removed: (s) => chalk.red(s),
		arrow: (s) => chalk.dim(s),
	};
};

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const stringifyValue = (value: unknown): string => {
	if (value === undefined || value === null || value === "") return UNSET;
	if (typeof value === "string") return value;
	if (typeof value === "boolean" || typeof value === "number") {
		return String(value);
	}
	return JSON.stringify(value);
};

/**
 * Expand one policy field into flat {@link FieldChange}s. When either side is a
 * plain object (compute settings, Data API settings) it splits into one
 * `field.key` entry per key across both sides, so the diff reads as sorted
 * scalar lines (`computeSettings.autoscalingLimitMaxCu  2 → 4`) rather than an
 * opaque JSON blob. Scalars produce a single entry.
 */
const expandField = (
	field: string,
	current: unknown,
	desired: unknown,
): FieldChange[] => {
	if (isPlainObject(current) || isPlainObject(desired)) {
		const cur = isPlainObject(current) ? current : {};
		const des = isPlainObject(desired) ? desired : {};
		const keys = Array.from(
			new Set([...Object.keys(cur), ...Object.keys(des)]),
		).sort();
		return keys.map((key) => ({
			field: `${field}.${key}`,
			...(key in cur ? { current: stringifyValue(cur[key]) } : {}),
			desired: stringifyValue(des[key]),
		}));
	}
	return [
		{
			field,
			...(current !== undefined
				? { current: stringifyValue(current) }
				: {}),
			desired: stringifyValue(desired),
		},
	];
};

/** Render the indented `field  current → desired` lines for one branch group. */
const renderFieldLines = (
	fields: FieldChange[],
	paint: ReturnType<typeof palette>,
): string[] => {
	const width = fields.reduce((max, f) => Math.max(max, f.field.length), 0);
	return fields.map((f) => {
		const name = f.field.padEnd(width);
		const arrow = paint.arrow("→");
		return f.current !== undefined
			? `      ${name}  ${paint.removed(f.current)} ${arrow} ${paint.added(f.desired)}`
			: `      ${name}  ${arrow} ${paint.added(f.desired)}`;
	});
};

/** Group field changes by branch, each block sorted alphabetically by field. */
const renderBranchGroups = (
	byBranch: Map<string, FieldChange[]>,
	paint: ReturnType<typeof palette>,
): string[] => {
	const lines: string[] = [];
	const groups = [...byBranch.entries()].sort((a, b) =>
		a[0].localeCompare(b[0]),
	);
	for (const [branch, fields] of groups) {
		const sorted = [...fields].sort((a, b) =>
			a.field.localeCompare(b.field),
		);
		lines.push(`  ${paint.group(`~ ${branch}`)}`);
		lines.push(...renderFieldLines(sorted, paint));
	}
	return lines;
};

/** Friendly label for a service change identifier (`bucket:x` → `bucket x`). */
const serviceLabel = (identifier: string): string => {
	if (identifier === "auth") return "Neon Auth";
	if (identifier === "dataApi") return "Data API";
	if (identifier.startsWith("bucket:")) {
		return `bucket ${identifier.slice("bucket:".length)}`;
	}
	if (identifier.startsWith("function:")) {
		return `function ${identifier.slice("function:".length)}`;
	}
	return identifier;
};

/**
 * The desired-only field changes for an applied/planned **branch** update. The
 * synthesized `AppliedChange.details` carry the new value keyed by `field`
 * (`parent`→`parent`, `ttl`→`expiresAt`, `protected`→`protected`,
 * `computeSettings`→`settings`); the previous value isn't threaded through in
 * Phase 1, so these render as `field → desired` (no red "before"). Object
 * settings expand into sub-fields.
 *
 * `parent` only ever arrives from a branch creation (it cannot be changed
 * afterwards), where it reports the parent the policy named.
 */
const appliedBranchFields = (change: AppliedChange): FieldChange[] => {
	const details = change.details ?? {};
	const field = typeof details.field === "string" ? details.field : "setting";
	switch (field) {
		case "parent":
			return expandField("parent", undefined, details.parent);
		case "ttl":
			return expandField("ttl", undefined, details.expiresAt);
		case "protected":
			return expandField("protected", undefined, details.protected);
		case "computeSettings":
			return expandField("computeSettings", undefined, details.settings);
		default:
			return expandField(field, undefined, details.settings);
	}
};

export const renderAppliedChanges = (
	changes: AppliedChange[],
	title: string,
	opts: { color: boolean },
): string => {
	if (changes.length === 0) return "";
	const paint = palette(opts.color);
	const lines: string[] = [paint.title(title)];

	const services = changes
		.filter((c) => c.kind === "service")
		.sort((a, b) => a.identifier.localeCompare(b.identifier));
	for (const service of services) {
		const label = serviceLabel(service.identifier);
		const line =
			service.action === "create"
				? `+ ${label}`
				: service.action === "delete"
					? `- ${label}`
					: `~ ${label}`;
		lines.push(
			`  ${
				service.action === "create"
					? paint.added(line)
					: service.action === "delete"
						? paint.removed(line)
						: paint.arrow(line)
			}`,
		);
	}

	const byBranch = new Map<string, FieldChange[]>();
	for (const change of changes.filter((c) => c.kind === "branch")) {
		const existing = byBranch.get(change.identifier) ?? [];
		byBranch.set(change.identifier, [
			...existing,
			...appliedBranchFields(change),
		]);
	}
	lines.push(...renderBranchGroups(byBranch, paint));

	return lines.join("\n");
};

/**
 * Render branch-setting **conflicts** (drift the policy wants to change but that
 * needs `--update-existing`) as a `git diff`-style before→after report: grouped
 * per branch, sorted by field, `current → desired` with the old value in red and
 * the new in green. Conflicts already carry both sides, so this is the fullest
 * form of the diff. Returns "" when there are no conflicts.
 */
export const renderBranchSettingConflicts = (
	conflicts: ConflictReport[],
	opts: { color: boolean },
): string => {
	if (conflicts.length === 0) return "";
	const paint = palette(opts.color);

	const byBranch = new Map<string, FieldChange[]>();
	for (const conflict of conflicts) {
		const existing = byBranch.get(conflict.identifier) ?? [];
		byBranch.set(conflict.identifier, [
			...existing,
			...expandField(conflict.field, conflict.current, conflict.desired),
		]);
	}

	const lines: string[] = [
		paint.title(
			"Branch settings differ (re-run with --update-existing to apply)",
		),
		...renderBranchGroups(byBranch, paint),
	];
	return lines.join("\n");
};
