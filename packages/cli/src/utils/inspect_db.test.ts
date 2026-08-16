import { describe, expect, it } from "vitest";
import { selectInspectTargets } from "./inspect_db.js";

describe("selectInspectTargets", () => {
	it("uses the --db-url database and never adds a column", () => {
		expect(
			selectInspectTargets({
				dbUrlDatabase: "from_url",
				databaseName: "ignored",
				branchDatabases: ["neondb", "other_db"],
				scope: "database",
			}),
		).toEqual({
			databases: ["from_url"],
			includeDatabaseColumn: false,
		});
	});

	it("uses --database-name and keeps the single-database schema", () => {
		expect(
			selectInspectTargets({
				databaseName: "other_db",
				branchDatabases: ["neondb", "other_db"],
				scope: "database",
			}),
		).toEqual({
			databases: ["other_db"],
			includeDatabaseColumn: false,
		});
	});

	it("omitting the flag on a database-scoped check covers every database and names them", () => {
		expect(
			selectInspectTargets({
				branchDatabases: ["other_db", "neondb"],
				scope: "database",
			}),
		).toEqual({
			databases: ["neondb", "other_db"],
			includeDatabaseColumn: true,
		});
	});

	it("still names the database when the branch only has one", () => {
		expect(
			selectInspectTargets({
				branchDatabases: ["neondb"],
				scope: "database",
			}),
		).toEqual({
			databases: ["neondb"],
			includeDatabaseColumn: true,
		});
	});

	it("omitting the flag on a compute-scoped check picks one database by sorted name", () => {
		expect(
			selectInspectTargets({
				branchDatabases: ["other_db", "neondb"],
				scope: "compute",
			}),
		).toEqual({
			databases: ["neondb"],
			includeDatabaseColumn: false,
		});
	});

	it("throws when the branch has no databases", () => {
		expect(() =>
			selectInspectTargets({
				branchDatabases: [],
				scope: "database",
			}),
		).toThrow("No databases found for the branch");
	});
});
