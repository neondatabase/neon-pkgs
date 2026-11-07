export const SQL_DEFAULT_MAX_ROWS = 100;
export const SQL_MAX_ROWS_LIMIT = 10_000;

export type Row = Record<string, unknown>;

export interface StatementRows {
	rows: Row[];
	totalRowCount: number;
	truncated: boolean;
	note?: string;
}

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
