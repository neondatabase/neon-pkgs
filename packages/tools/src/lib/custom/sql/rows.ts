import * as z from "zod";

export const SQL_DEFAULT_MAX_ROWS = 100;
export const SQL_MAX_ROWS_LIMIT = 10_000;

/** A result row by column name. Postgres types JSON has no form for, such as int8, arrive as strings. */
export const rowSchema = z.record(z.string(), z.unknown());
export type Row = z.infer<typeof rowSchema>;

export const statementRowsSchema = z.strictObject({
	rows: z.array(rowSchema),
	totalRowCount: z.number(),
	truncated: z.boolean(),
	note: z.string().nullish(),
});
export type StatementRows = z.infer<typeof statementRowsSchema>;

// Whether a rerun is safe can't be read from the result: a data-modifying CTE
// or a function call with side effects still reports a SELECT command tag.
const truncationNote = (maxRows: number, totalRowCount: number): string => {
	const shown = `Showing the first ${maxRows} of ${totalRowCount} rows.`;
	const rerun =
		"The SQL already ran, so if it changed data, running it again repeats the change.";
	if (maxRows < SQL_MAX_ROWS_LIMIT) {
		return `${shown} To see more, raise \`max_rows\` or narrow the query with WHERE or LIMIT. ${rerun}`;
	}
	return `${shown} That is the maximum this tool returns. To see the rest, narrow the query with WHERE or LIMIT. ${rerun}`;
};

export const capRows = (rows: Row[], maxRows: number): StatementRows => {
	const truncated = rows.length > maxRows;
	return {
		rows: truncated ? rows.slice(0, maxRows) : rows,
		totalRowCount: rows.length,
		truncated,
		...(truncated && { note: truncationNote(maxRows, rows.length) }),
	};
};
