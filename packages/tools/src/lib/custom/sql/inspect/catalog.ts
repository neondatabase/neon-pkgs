import {
	INSPECT_CHECKS,
	INSPECT_QUERIES,
	type InspectCheck,
} from "./queries.js";
import { emptyResultNote } from "./report.js";
import type { InspectQueryScope } from "./targets.js";

export interface InspectCheckInfo {
	readonly id: InspectCheck;
	/** The `describe` text the result carries. */
	readonly description: string;
	/** `compute` checks run once for the whole compute, whatever `database_name` is. */
	readonly scope: InspectQueryScope;
	/** The extension the check needs; without it the tool throws before running SQL. */
	readonly requiresExtension?: string;
	/** Output columns in order. A run over every database adds `database` first. */
	readonly fields: readonly string[];
	/** Rows the SQL returns at most, per database. */
	readonly sqlLimit?: number;
	/** The `note` of an empty result for one database, or for a `compute` check. */
	readonly emptyNote: string;
	/** The `note` of an empty result when `database_name` is omitted. Only `database` checks have it. */
	readonly emptyNoteAllDatabases?: string;
}

/** The checks `database.inspect` runs, in the order its `check` input lists them. */
export const inspectChecks: readonly InspectCheckInfo[] = Object.freeze(
	INSPECT_CHECKS.map((id) => {
		const query = INSPECT_QUERIES[id];
		return Object.freeze({
			id,
			description: query.describe,
			scope: query.scope,
			...(query.requiresExtension === undefined
				? {}
				: { requiresExtension: query.requiresExtension }),
			fields: Object.freeze([...query.fields]),
			...(query.sqlLimit === undefined
				? {}
				: { sqlLimit: query.sqlLimit }),
			emptyNote: emptyResultNote(query, false),
			...(query.scope === "database"
				? { emptyNoteAllDatabases: emptyResultNote(query, true) }
				: {}),
		});
	}),
);
