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
	database?: string;
	pid: string;
	relname: string | null;
	mode: string;
	locktype: string;
	granted: string;
	age: string;
	query: string;
};

type TableSizeRow = {
	database?: string;
	schema: string;
	name: string;
	size: string;
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
 * `pg_locks` and `pg_stat_activity` span the compute, while relation OIDs are
 * database-local. A second database makes foreign rows and misresolved OIDs
 * observable.
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

			const allSizes = await runCliJson<TableSizeRow[]>([
				"inspect",
				"db",
				"table-sizes",
				"--project-id",
				projectId,
			]);
			expect(
				allSizes.some(
					(row) =>
						row.database === "neondb" && row.name === DEFAULT_TABLE,
				),
			).toBe(true);
			expect(
				allSizes.some(
					(row) =>
						row.database === OTHER_DATABASE &&
						row.name === OTHER_TABLE,
				),
			).toBe(true);
			expect(
				allSizes
					.filter((row) => row.name === DEFAULT_TABLE)
					.every((row) => row.database === "neondb"),
			).toBe(true);
			expect(
				allSizes
					.filter((row) => row.name === OTHER_TABLE)
					.every((row) => row.database === OTHER_DATABASE),
			).toBe(true);

			const namedSizes = await runCliJson<TableSizeRow[]>([
				"inspect",
				"db",
				"table-sizes",
				"--project-id",
				projectId,
				"--database-name",
				"neondb",
			]);
			expect(namedSizes.some((row) => row.name === DEFAULT_TABLE)).toBe(
				true,
			);
			expect(namedSizes.every((row) => row.database === undefined)).toBe(
				true,
			);

			const slots = await runCliJson<unknown[]>([
				"inspect",
				"db",
				"replication-slots",
				"--project-id",
				projectId,
			]);
			expect(Array.isArray(slots)).toBe(true);

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

			// Keep both locks active so each inspection can expose a foreign lock.
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
					// `LOCK TABLE` does not assign a transaction ID, so force one to
					// test a database-less lock from this session.
					await defaultSession.query("SELECT pg_current_xact_id()");
					const backendPid = await defaultSession.query(
						"SELECT pg_backend_pid()",
					);
					const defaultPid = String(backendPid.rows[0]?.[0]);

					const fromDefault = await inspectLocks("neondb");
					const fromOther = await inspectLocks(OTHER_DATABASE);
					const fromAll = await runCliJson<LockRow[]>([
						"inspect",
						"db",
						"locks",
						"--project-id",
						projectId,
					]);

					const relnames = (rows: LockRow[]) =>
						rows
							.filter((row) => row.locktype === "relation")
							.map((row) => row.relname);

					expect(relnames(fromDefault)).toContain(DEFAULT_TABLE);
					expect(relnames(fromDefault)).not.toContain(OTHER_TABLE);
					expect(relnames(fromOther)).toContain(OTHER_TABLE);
					expect(relnames(fromOther)).not.toContain(DEFAULT_TABLE);

					for (const rows of [fromDefault, fromOther]) {
						for (const row of rows.filter(
							(candidate) => candidate.locktype === "relation",
						)) {
							expect(row.relname).not.toBeNull();
						}
					}

					// `transactionid` locks have no database, so filtering on
					// `pg_locks.database` would drop them.
					expect(
						fromDefault
							.filter((row) => row.pid === defaultPid)
							.map((row) => row.locktype),
					).toContain("transactionid");

					expect(
						fromDefault.every((row) => row.database === undefined),
					).toBe(true);
					expect(
						fromAll
							.filter(
								(row) =>
									row.locktype === "relation" &&
									row.relname === DEFAULT_TABLE,
							)
							.every((row) => row.database === "neondb"),
					).toBe(true);
					expect(
						fromAll
							.filter(
								(row) =>
									row.locktype === "relation" &&
									row.relname === OTHER_TABLE,
							)
							.every((row) => row.database === OTHER_DATABASE),
					).toBe(true);
					for (const row of fromAll.filter(
						(candidate) => candidate.locktype === "relation",
					)) {
						expect(row.relname).not.toBeNull();
					}

					await defaultSession.query("ROLLBACK");
				});

				await otherSession.query("ROLLBACK");
			});
		},
	);
});
