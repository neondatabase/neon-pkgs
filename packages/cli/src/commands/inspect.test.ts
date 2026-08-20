import { describe, expect } from "vitest";
import { test } from "../test_utils/fixtures";
import { INSPECT_QUERIES } from "../utils/inspect_queries.js";

// `inspect db` opens a real Postgres connection with the embedded wire client,
// so these tests drive the hermetic `--db-url` path: point at a port nothing is
// listening on and assert the command (a) bypasses the Neon API entirely and
// (b) fails with a clear Postgres-connection error rather than the Neon-API
// "Could not reach the Neon API" hint. `127.0.0.1:1` refuses immediately.
const UNREACHABLE_DB_URL = "postgresql://user:pass@127.0.0.1:1/postgres";

describe("inspect db", () => {
	test("table-sizes --db-url bypasses the API and reports a Postgres connection error", async ({
		testCliCommand,
	}) => {
		await testCliCommand(
			["inspect", "db", "table-sizes", "--db-url", UNREACHABLE_DB_URL],
			{
				code: 1,
				stderr: expect.stringMatching(
					/Could not connect to Postgres at 127\.0\.0\.1:1/,
				),
			},
		);
	});

	test("locks --db-url bypasses the API and reports a Postgres connection error", async ({
		testCliCommand,
	}) => {
		await testCliCommand(
			["inspect", "db", "locks", "--db-url", UNREACHABLE_DB_URL],
			{
				code: 1,
				stderr: expect.stringMatching(
					/Could not connect to Postgres at 127\.0\.0\.1:1/,
				),
			},
		);
	});

	test("locks --db-url does not suffix a database the URL already named", async ({
		testCliCommand,
	}) => {
		await testCliCommand(
			["inspect", "db", "locks", "--db-url", UNREACHABLE_DB_URL],
			{
				code: 1,
				stderr: expect.not.stringContaining("(database postgres)"),
			},
		);
	});

	test("inspect db --help says omit --database-name covers every database", async ({
		testCliCommand,
	}) => {
		await testCliCommand(["inspect", "db", "--help"], {
			mockDir: "single_org",
			stderr: expect.stringContaining(
				"Ranking and row limits stay per database",
			),
		});
	});

	test("inspect db --help says one failing database fails the run", async ({
		testCliCommand,
	}) => {
		await testCliCommand(["inspect", "db", "--help"], {
			mockDir: "single_org",
			stderr: expect.stringContaining("fails the whole run"),
		});
	});

	test("inspect db --help marks compute-wide subcommands", async ({
		testCliCommand,
	}) => {
		await testCliCommand(["inspect", "db", "--help"], {
			mockDir: "single_org",
			stderr: expect.stringContaining(
				"Local File Cache hit rate (compute-wide",
			),
		});
	});

	test("stalled-queries is compute-wide and preserves its diagnostic fields", () => {
		expect(INSPECT_QUERIES["stalled-queries"]).toMatchObject({
			scope: "compute",
			fields: [
				"observed_at",
				"query_start",
				"query_group",
				"pid",
				"leader_pid",
				"role",
				"backend_type",
				"database",
				"application_name",
				"query_id",
				"state",
				"wait_event_type",
				"wait_event",
				"blocking_pids",
				"duration",
				"query",
			],
		});
	});

	// Phase-2 subcommands. The extension-gated ones (`outliers`, `calls`) still
	// fail at the connection step here — the `pg_stat_statements` guard only runs
	// after a successful connect — so they share the same wiring assertion.
	for (const sub of [
		"stalled-queries",
		"seq-scans",
		"vacuum-stats",
		"bloat",
		"outliers",
		"calls",
		"lfc-hit-rate",
		"working-set",
		"replication-slots",
		"subscriptions",
	] as const) {
		test(`${sub} --db-url bypasses the API and reports a Postgres connection error`, async ({
			testCliCommand,
		}) => {
			await testCliCommand(
				["inspect", "db", sub, "--db-url", UNREACHABLE_DB_URL],
				{
					code: 1,
					stderr: expect.stringMatching(
						/Could not connect to Postgres at 127\.0\.0\.1:1/,
					),
				},
			);
		});
	}
});
