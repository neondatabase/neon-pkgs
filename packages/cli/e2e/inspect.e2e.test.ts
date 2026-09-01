import { sleep } from "@neon/e2e-harness";
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

async function backendPid(session: PgConnection): Promise<number> {
	const result = await session.query("SELECT pg_backend_pid()");
	const value = result.rows[0]?.[0];
	if (typeof value !== "string" && typeof value !== "number") {
		throw new Error(`pg_backend_pid returned ${String(value)}`);
	}
	const pid = Number(value);
	if (!Number.isFinite(pid) || pid <= 0) {
		throw new Error(`pg_backend_pid returned ${String(value)}`);
	}
	return pid;
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
				const otherBackendPid = await otherSession.query(
					"SELECT pg_backend_pid()",
				);
				const otherPid = String(otherBackendPid.rows[0]?.[0]);

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
					expect(
						fromDefault.every((row) => row.pid !== otherPid),
					).toBe(true);
					expect(
						fromOther.every((row) => row.pid !== defaultPid),
					).toBe(true);

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
					expect(fromAll).toEqual(
						expect.arrayContaining([
							expect.objectContaining({
								locktype: "relation",
								relname: DEFAULT_TABLE,
								database: "neondb",
							}),
							expect.objectContaining({
								locktype: "relation",
								relname: OTHER_TABLE,
								database: OTHER_DATABASE,
							}),
						]),
					);
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

	e2eTest(
		"stalled-queries reports backends past 30 seconds, oldest group first",
		async ({ track }) => {
			const projectId = await createProject({
				name: uniqueProjectName("cli-inspect-stall"),
			});
			track(projectId);

			const empty = await runCliJson<Record<string, unknown>[]>([
				"inspect",
				"db",
				"stalled-queries",
				"--project-id",
				projectId,
			]);
			expect(empty).toEqual([]);

			const uri = await connectionUriFor(projectId, "neondb");
			const first = await PgConnection.connect(parseConnectionUri(uri));
			const second = await PgConnection.connect(parseConnectionUri(uri));
			try {
				const firstPid = await backendPid(first);
				const secondPid = await backendPid(second);
				if (firstPid === secondPid) {
					throw new Error(
						`both inspect sessions reported pid ${firstPid}`,
					);
				}
				// Older query on the higher pid, so pid-primary order would
				// rank it after the newer one.
				const older = firstPid > secondPid ? first : second;
				const newer = older === first ? second : first;

				const pendingOlder = older.query(
					"SELECT pg_sleep(90) /* stall-older */",
				);
				pendingOlder.catch(() => undefined);
				await sleep(5_000);
				const pendingNewer = newer.query(
					"SELECT pg_sleep(90) /* stall-newer */",
				);
				pendingNewer.catch(() => undefined);
				await sleep(32_000);

				const rows = await runCliJson<Record<string, unknown>[]>([
					"inspect",
					"db",
					"stalled-queries",
					"--project-id",
					projectId,
				]);
				const stallRows = rows.filter((row) =>
					String(row.query).includes("pg_sleep"),
				);
				expect(stallRows.length).toBeGreaterThanOrEqual(2);

				const olderIdx = stallRows.findIndex((row) =>
					String(row.query).includes("stall-older"),
				);
				const newerIdx = stallRows.findIndex((row) =>
					String(row.query).includes("stall-newer"),
				);
				expect(olderIdx).toBeGreaterThanOrEqual(0);
				expect(newerIdx).toBeGreaterThanOrEqual(0);
				expect(olderIdx).toBeLessThan(newerIdx);
				expect(Number(stallRows[olderIdx]?.pid)).toBeGreaterThan(
					Number(stallRows[newerIdx]?.pid),
				);

				const hit = stallRows[olderIdx];
				expect(hit?.role).toBe("leader");
				expect(String(hit?.query_group)).toBe(String(hit?.pid));
				expect(hit?.state).toBe("active");
				expect(typeof hit?.duration).toBe("string");

				await older.cancel();
				await newer.cancel();
			} finally {
				await first.close();
				await second.close();
			}
		},
		240_000,
	);
});
