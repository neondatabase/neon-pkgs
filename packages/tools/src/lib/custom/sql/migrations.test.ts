import { describe, expect, test } from "vitest";
import { splitSqlStatements } from "./migrations.js";

describe("splitSqlStatements", () => {
	test("splits on every semicolon and drops empty segments", () => {
		expect(
			splitSqlStatements(
				"CREATE TABLE a (id int);;ALTER TABLE a ADD COLUMN b text;",
			),
		).toEqual([
			"CREATE TABLE a (id int)",
			"ALTER TABLE a ADD COLUMN b text",
		]);
	});

	test("keeps whitespace-only segments, which run as empty statements", () => {
		expect(splitSqlStatements("SELECT 1;\n")).toEqual(["SELECT 1", "\n"]);
	});
});
