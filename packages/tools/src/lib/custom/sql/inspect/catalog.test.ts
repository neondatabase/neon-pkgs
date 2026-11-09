import { describe, expect, test } from "vitest";
import { inspectChecks } from "../../../../index.js";
import { INSPECT_CHECKS, INSPECT_QUERIES } from "./queries.js";
import { assembleInspectReport } from "./report.js";

const emptyRun = (
	check: (typeof INSPECT_CHECKS)[number],
	includeDatabaseColumn: boolean,
) =>
	assembleInspectReport({
		check,
		query: INSPECT_QUERIES[check],
		projectId: "project-id",
		branchId: "br-id",
		batches: [{ database: "neondb", rows: [] }],
		includeDatabaseColumn,
		includeDatabaseName: !includeDatabaseColumn,
		limit: 50,
	}).note;

describe("inspectChecks", () => {
	test("lists every check the tool accepts, in order, and cannot be changed", () => {
		expect(inspectChecks.map((check) => check.id)).toEqual([
			...INSPECT_CHECKS,
		]);
		expect(Object.isFrozen(inspectChecks)).toBe(true);
		for (const check of inspectChecks) {
			expect(Object.isFrozen(check), check.id).toBe(true);
			expect(Object.isFrozen(check.fields), check.id).toBe(true);
		}
	});

	test("names the extension each check needs and the compute-wide checks", () => {
		expect(
			Object.fromEntries(
				inspectChecks
					.filter((check) => check.requiresExtension !== undefined)
					.map((check) => [check.id, check.requiresExtension]),
			),
		).toEqual({
			outliers: "pg_stat_statements",
			calls: "pg_stat_statements",
			"lfc-hit-rate": "neon",
			"working-set": "neon",
		});
		expect(
			inspectChecks
				.filter((check) => check.scope === "compute")
				.map((check) => check.id),
		).toEqual([
			"stalled-queries",
			"lfc-hit-rate",
			"working-set",
			"replication-slots",
		]);
	});

	test("carries the notes, fields, and caps the tool reports", () => {
		for (const check of inspectChecks) {
			const query = INSPECT_QUERIES[check.id];
			expect(check.description).toBe(query.describe);
			expect(check.fields).toEqual(query.fields);
			expect(check.sqlLimit).toBe(query.sqlLimit);
			expect(check.emptyNote, check.id).toBe(emptyRun(check.id, false));
			if (check.scope === "database") {
				expect(check.emptyNoteAllDatabases, check.id).toBe(
					emptyRun(check.id, true),
				);
			} else {
				expect(check).not.toHaveProperty("emptyNoteAllDatabases");
			}
		}
		expect(
			inspectChecks.find((check) => check.id === "locks"),
		).toMatchObject({
			emptyNote: "No locks held in this database.",
			emptyNoteAllDatabases: "No locks held in any database.",
		});
	});
});
