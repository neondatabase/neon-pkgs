import { describe, expect, it } from "vitest";
import {
	connectionUriForDatabase,
	formatInspectQueryError,
	type ResolveInspectTargetsProps,
	resolveInspectTargets,
	selectInspectTargets,
} from "./inspect_db.js";

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

	it("omitting the flag on a compute-scoped check picks the first listed database", () => {
		expect(
			selectInspectTargets({
				branchDatabases: ["other_db", "neondb"],
				scope: "compute",
			}),
		).toEqual({
			databases: ["other_db"],
			includeDatabaseColumn: false,
		});
	});

	it("rejects an empty --database-name", () => {
		expect(() =>
			selectInspectTargets({
				databaseName: "",
				branchDatabases: ["neondb", "other_db"],
				scope: "database",
			}),
		).toThrow(
			"--database-name cannot be empty. Omit the flag to cover every database.",
		);
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

describe("formatInspectQueryError", () => {
	it("leaves --db-url and --database-name errors unchanged", () => {
		expect(
			formatInspectQueryError({
				reason: "missing neon",
				database: "postgres",
				dbUrl: "postgresql://localhost/postgres",
				offerDatabaseNameHint: false,
				scope: "database",
			}),
		).toBeUndefined();
		expect(
			formatInspectQueryError({
				reason: "missing neon",
				database: "neondb",
				databaseName: "neondb",
				offerDatabaseNameHint: true,
				scope: "database",
			}),
		).toBeUndefined();
	});

	it("names the database the CLI chose when the flag is omitted", () => {
		expect(
			formatInspectQueryError({
				reason: "missing neon",
				database: "other_db",
				offerDatabaseNameHint: false,
				scope: "compute",
			}),
		).toBe("missing neon (database other_db)");
	});

	it("points at --database-name when a database-scoped fan-out fails", () => {
		expect(
			formatInspectQueryError({
				reason: "missing neon",
				database: "analytics",
				offerDatabaseNameHint: true,
				scope: "database",
			}),
		).toBe(
			"missing neon (database analytics). Pass --database-name to inspect one database.",
		);
	});

	it("tells compute-wide omit to connect through a different database", () => {
		expect(
			formatInspectQueryError({
				reason: "missing neon",
				database: "analytics",
				offerDatabaseNameHint: true,
				scope: "compute",
			}),
		).toBe(
			"missing neon (database analytics). Pass --database-name to connect through a different database.",
		);
	});
});

describe("connectionUriForDatabase", () => {
	it("encodes a literal percent in the database name", () => {
		expect(
			connectionUriForDatabase(
				"postgresql://user:pass@ep-1.neon.tech/neondb?sslmode=require",
				"sales%2026",
			),
		).toBe(
			"postgresql://user:pass@ep-1.neon.tech/sales%252026?sslmode=require",
		);
	});
});

describe("resolveInspectTargets", () => {
	it("keeps point-in-time on the branch when --database-name is omitted", async () => {
		const branch = "br-main-branch-123456@0/234235";
		const props: ResolveInspectTargetsProps = {
			projectId: "proj-1",
			branch,
			roleName: "neondb_owner",
			apiKey: "test-key",
			apiHost: "https://console.neon.tech/api/v2",
			output: "json",
			contextFile: "/dev/null",
			apiClient: {
				listProjectBranchDatabases: async () => ({
					data: {
						databases: [{ name: "other_db" }, { name: "neondb" }],
					},
				}),
				listProjectBranchEndpoints: async () => ({
					data: {
						endpoints: [
							{
								type: "read_write",
								host: "ep-1.neon.tech",
								id: "ep-1",
								branch_id: "br-main-branch-123456",
							},
						],
					},
				}),
				getProjectBranchRolePassword: async () => ({
					data: { password: "secret" },
				}),
			} as never,
		};

		const resolved = await resolveInspectTargets(props, "database");

		expect(resolved.branchDatabaseCount).toBe(2);
		expect(resolved.targets).toHaveLength(2);
		for (const target of resolved.targets) {
			expect(decodeURIComponent(target.connectionUri)).toContain(
				"neon_lsn:0/234235",
			);
		}
	});
});
