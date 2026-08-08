import { describe, expect } from "vitest";
import { parseConnectionUri } from "../src/psql/index.js";
import { PgConnection } from "../src/psql/wire/connection.js";
import {
	createProject,
	e2eTest,
	runCli,
	runCliJson,
	uniqueProjectName,
} from "./helpers.js";

type LockRow = {
	pid: string;
	relname: string | null;
	mode: string;
	locktype: string;
	granted: string;
	age: string;
	query: string;
};

const OTHER_DATABASE = "other_db";
const OTHER_TABLE = "other_only_table";
const DEFAULT_TABLE = "default_only_table";

async function connectionUriFor(
	projectId: string,
	databaseName: string,
): Promise<string> {
	const result = await runCli(
		[
			"connection-string",
			"--project-id",
			projectId,
			"--database-name",
			databaseName,
		],
		{ json: false },
	);
	if (result.code !== 0) {
		throw new Error(
			`connection-string for ${databaseName} exited ${result.code}\n${result.stderr}`,
		);
	}
	return result.stdout.trim();
}

async function withSession<T>(
	uri: string,
	run: (session: PgConnection) => Promise<T>,
): Promise<T> {
	const session = await PgConnection.connect(parseConnectionUri(uri));
	try {
		return await run(session);
	} finally {
		await session.close();
	}
}

/**
 * `pg_locks` and `pg_stat_activity` are compute-wide, not database-scoped, so a
 * two-database branch is the only way to catch `inspect db` reporting another
 * database's rows. It is also the only way to catch the consequence that made
 * this worth fixing: `pg_locks.relation` is an OID that means nothing outside
 * `pg_locks.database`, so resolving a foreign one against the local `pg_class`
 * produced a null name, or another relation that happened to share the OID.
 */
describe.sequential("e2e — neon inspect db against the real API", () => {
	e2eTest(
		"reports only the inspected database's locks, with resolvable names",
		async ({ track }) => {
			const projectId = await createProject({
				name: uniqueProjectName("cli-inspect"),
			});
			track(projectId);

			const created = await runCliJson<{ name: string }>([
				"databases",
				"create",
				"--project-id",
				projectId,
				"--name",
				OTHER_DATABASE,
			]);
			expect(created.name).toBe(OTHER_DATABASE);

			const [defaultUri, otherUri] = await Promise.all([
				connectionUriFor(projectId, "neondb"),
				connectionUriFor(projectId, OTHER_DATABASE),
			]);

			await withSession(defaultUri, (session) =>
				session.query(`CREATE TABLE ${DEFAULT_TABLE} (id int)`),
			);
			await withSession(otherUri, (session) =>
				session.query(`CREATE TABLE ${OTHER_TABLE} (id int)`),
			);

			const inspectLocks = (databaseName: string) =>
				runCliJson<LockRow[]>([
					"inspect",
					"db",
					"locks",
					"--project-id",
					projectId,
					"--database-name",
					databaseName,
				]);

			// Hold an ACCESS EXCLUSIVE lock in each database at the same time, so
			// each inspect call has a foreign lock available to wrongly report.
			await withSession(otherUri, async (otherSession) => {
				await otherSession.query("BEGIN");
				await otherSession.query(
					`LOCK TABLE ${OTHER_TABLE} IN ACCESS EXCLUSIVE MODE`,
				);

				await withSession(defaultUri, async (defaultSession) => {
					await defaultSession.query("BEGIN");
					await defaultSession.query(
						`LOCK TABLE ${DEFAULT_TABLE} IN ACCESS EXCLUSIVE MODE`,
					);

					const fromDefault = await inspectLocks("neondb");
					const fromOther = await inspectLocks(OTHER_DATABASE);

					const relnames = (rows: LockRow[]) =>
						rows
							.filter((row) => row.locktype === "relation")
							.map((row) => row.relname);

					expect(relnames(fromDefault)).toContain(DEFAULT_TABLE);
					expect(relnames(fromDefault)).not.toContain(OTHER_TABLE);
					expect(relnames(fromOther)).toContain(OTHER_TABLE);
					expect(relnames(fromOther)).not.toContain(DEFAULT_TABLE);

					// The regression itself: a relation lock from another database
					// resolved to a null name here, which reads as a non-relation lock.
					for (const rows of [fromDefault, fromOther]) {
						for (const row of rows.filter(
							(candidate) => candidate.locktype === "relation",
						)) {
							expect(row.relname).not.toBeNull();
						}
					}

					// Locks that have no relation must survive the database filter —
					// they carry no `pg_locks.database`, so filtering on the lock rather
					// than on the holding session would have dropped them.
					expect(fromDefault.map((row) => row.locktype)).toContain(
						"transactionid",
					);

					await defaultSession.query("ROLLBACK");
				});

				await otherSession.query("ROLLBACK");
			});
		},
	);
});
