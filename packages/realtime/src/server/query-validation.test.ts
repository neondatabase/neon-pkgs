import { describe, expect, it } from "vitest";

import { validateLiveSelectSql } from "./query-validation.js";

describe("validateLiveSelectSql", () => {
	it.each([
		"SELECT DISTINCT category FROM events",
		"SELECT category, count(*) FROM events GROUP BY category HAVING count(*) > 1",
	])("accepts a supported Realtime query: %s", (sql) => {
		expect(() => validateLiveSelectSql(sql)).not.toThrow();
	});
});
