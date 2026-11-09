import { describe, expect, test } from "vitest";
import { capRows, SQL_MAX_ROWS_LIMIT } from "./rows.js";

const rows = (count: number) =>
	Array.from({ length: count }, (_, index) => ({ n: index }));

describe("capRows", () => {
	test("keeps every row and reports no truncation when the rows fit", () => {
		expect(capRows(rows(2), 2)).toEqual({
			rows: rows(2),
			totalRowCount: 2,
			truncated: false,
		});
	});

	test("cuts to max_rows and says how to see more", () => {
		const capped = capRows(rows(5), 2);
		expect(capped.rows).toEqual(rows(2));
		expect(capped.totalRowCount).toBe(5);
		expect(capped.truncated).toBe(true);
		expect(capped.note).toBe(
			"Showing the first 2 of 5 rows. To see more, raise `max_rows` or narrow the query with WHERE or LIMIT. The SQL already ran, so if it changed data, running it again repeats the change.",
		);
	});

	test("at the ceiling, tells the caller to narrow the query instead", () => {
		const capped = capRows(
			rows(SQL_MAX_ROWS_LIMIT + 1),
			SQL_MAX_ROWS_LIMIT,
		);
		expect(capped.note).toBe(
			`Showing the first ${SQL_MAX_ROWS_LIMIT} of ${SQL_MAX_ROWS_LIMIT + 1} rows. That is the maximum this tool returns. To see the rest, narrow the query with WHERE or LIMIT. The SQL already ran, so if it changed data, running it again repeats the change.`,
		);
	});
});
