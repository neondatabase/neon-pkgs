import stripAnsi from "strip-ansi";
import { describe, expect, it } from "vitest";

import {
	type DatabaseSchemaDiff,
	renderDatabaseSchemaDiff,
	renderSchemaDiffReport,
} from "./git_diff";

const BEFORE = {
	branchName: "main",
	branchId: "br-main-1111",
};
const AFTER = {
	branchName: "feature",
	branchId: "br-feat-2222",
};

const diffOf = (before: string, after: string): DatabaseSchemaDiff => ({
	database: "neondb",
	before: { ...BEFORE, sql: before },
	after: { ...AFTER, sql: after },
});

describe("renderDatabaseSchemaDiff", () => {
	it("reports no changes for identical schemas", () => {
		const schema = "CREATE TABLE users (id int);\n";
		const result = renderDatabaseSchemaDiff(diffOf(schema, schema), {
			color: false,
		});
		expect(result.hasChanges).toBe(false);
		expect(result.text).toBe("");
	});

	it("renders a git-style unified diff with branch-labeled headers", () => {
		const before = "CREATE TABLE users (\n  id int\n);\n";
		const after = "CREATE TABLE users (\n  id int,\n  email text\n);\n";
		const { hasChanges, text } = renderDatabaseSchemaDiff(
			diffOf(before, after),
			{ color: false },
		);

		expect(hasChanges).toBe(true);
		const lines = text.split("\n");
		expect(lines[0]).toBe("diff --neon database neondb");
		expect(lines[1]).toBe("--- main (br-main-1111)");
		expect(lines[2]).toBe("+++ feature (br-feat-2222)");
		// A hunk header, an added line, and a removed line are all present.
		expect(text).toMatch(/^@@ -\d+,\d+ \+\d+,\d+ @@$/m);
		expect(text).toMatch(/^\+ {2}email text/m);
		expect(text).toContain("-  id int");
		expect(text).toContain("+  id int,");
	});

	it("shows an entirely new schema as all additions (empty reference side)", () => {
		const after = "CREATE TABLE only_here (id int);\n";
		const { hasChanges, text } = renderDatabaseSchemaDiff(
			diffOf("", after),
			{ color: false },
		);
		expect(hasChanges).toBe(true);
		expect(text).toContain("+CREATE TABLE only_here (id int);");
		expect(text).not.toMatch(/^-CREATE/m);
	});

	it("keeps the exact same layout with color on, only adding ANSI codes", () => {
		const before = "CREATE TABLE t (a int);\n";
		const after = "CREATE TABLE t (a int, b int);\n";
		const plain = renderDatabaseSchemaDiff(diffOf(before, after), {
			color: false,
		});
		const colored = renderDatabaseSchemaDiff(diffOf(before, after), {
			color: true,
		});
		// Stripping ANSI from the colored output must reproduce the plain output.
		expect(stripAnsi(colored.text)).toBe(plain.text);
	});
});

describe("renderSchemaDiffReport", () => {
	it("includes only databases that changed and lists them", () => {
		const unchanged = "CREATE TABLE a (id int);\n";
		const diffs: DatabaseSchemaDiff[] = [
			{
				database: "unchanged_db",
				before: { ...BEFORE, sql: unchanged },
				after: { ...AFTER, sql: unchanged },
			},
			{
				database: "changed_db",
				before: { ...BEFORE, sql: "CREATE TABLE b (id int);\n" },
				after: {
					...AFTER,
					sql: "CREATE TABLE b (id int, name text);\n",
				},
			},
		];

		const report = renderSchemaDiffReport(diffs, { color: false });
		expect(report.hasChanges).toBe(true);
		expect(report.changedDatabases).toEqual(["changed_db"]);
		expect(report.text).toContain("diff --neon database changed_db");
		expect(report.text).not.toContain("unchanged_db");
	});

	it("reports no changes when every database is identical", () => {
		const schema = "CREATE TABLE a (id int);\n";
		const report = renderSchemaDiffReport(
			[
				{
					database: "db1",
					before: { ...BEFORE, sql: schema },
					after: { ...AFTER, sql: schema },
				},
			],
			{ color: false },
		);
		expect(report.hasChanges).toBe(false);
		expect(report.text).toBe("");
		expect(report.changedDatabases).toEqual([]);
	});
});
