import { describe, expect, it } from "vitest";
import {
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

		expect(resolved.targets).toHaveLength(2);
		for (const target of resolved.targets) {
			expect(decodeURIComponent(target.connectionUri)).toContain(
				"neon_lsn:0/234235",
			);
		}
	});
});
