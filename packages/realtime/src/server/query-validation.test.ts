import { describe, expect, it } from "vitest";

import { validateLiveSelectSql } from "./query-validation.js";

describe("validateLiveSelectSql", () => {
	it.each([
		"SELECT DISTINCT category FROM events",
		"SELECT category, count(*) FROM events GROUP BY category HAVING count(*) > 1",
	])("accepts a supported Realtime query: %s", (sql) => {
		expect(() => validateLiveSelectSql(sql)).not.toThrow();
	});

	it.each([
		"DELETE FROM events",
		"SELECT * FROM events;",
	])("rejects input that is not one SELECT statement: %s", (sql) => {
		expect(() => validateLiveSelectSql(sql)).toThrow(
			"Live queries must compile to one SELECT statement",
		);
	});
});
