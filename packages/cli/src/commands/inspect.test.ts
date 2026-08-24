import { PassThrough } from "node:stream";
import stripAnsi from "strip-ansi";
import { describe, expect } from "vitest";
import { test } from "../test_utils/fixtures";
import { INSPECT_QUERIES } from "../utils/inspect_queries.js";
import { writer } from "../writer.js";

// `inspect db` opens a real Postgres connection with the embedded wire client,
// so these tests drive the hermetic `--db-url` path: point at a port nothing is
// listening on and assert the command (a) bypasses the Neon API entirely and
// (b) fails with a clear Postgres-connection error rather than the Neon-API
// "Could not reach the Neon API" hint. `127.0.0.1:1` refuses immediately.
const UNREACHABLE_DB_URL = "postgresql://user:pass@127.0.0.1:1/postgres";

const STALLED_QUERY_ROW = {
	observed_at: "2026-08-20 21:27:52.147991+00",
	query_start: "2026-08-20 21:27:10.224566+00",
	query_group: "952",
	pid: "953",
	leader_pid: "952",
	role: "worker",
	backend_type: "parallel worker",
	database: "neondb",
	application_name: "checkout-api",
	query_id: "5457019535816659310",
	state: "active",
	wait_event_type: "IO",
	wait_event: "DataFileRead",
	blocking_pids: "",
	duration: "00:00:41.923425",
	query: "SELECT customer_id FROM checkout_events WHERE account_id = $1 ORDER BY created_at DESC",
};

const BLOCKED_STALLED_QUERY_ROW = {
	...STALLED_QUERY_ROW,
	blocking_pids: "771",
};

const captureWriter = (
	output: "table" | "json",
	columns?: number,
	rows: Record<string, string>[] = [STALLED_QUERY_ROW],
) => {
	const chunks: string[] = [];
	const out = new PassThrough();
	out.on("data", (chunk) => chunks.push(chunk.toString()));
	writer({ output, out, columns }).end(rows, {
		fields: INSPECT_QUERIES["stalled-queries"].fields,
	});
	return chunks.join("");
};

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
		expect(INSPECT_QUERIES["stalled-queries"].sql).toContain(
			"array_to_string(pg_blocking_pids(a.pid), ',')",
		);
		expect(INSPECT_QUERIES["stalled-queries"].sql).toContain(
			"min(query_start) AS group_start",
		);
		expect(INSPECT_QUERIES["stalled-queries"].sql).toContain(
			"ORDER BY g.group_start, g.query_group, a.leader_pid NULLS FIRST, a.pid",
		);
		expect(INSPECT_QUERIES["stalled-queries"].sql).not.toContain(
			"SELECT DISTINCT COALESCE(leader_pid, pid) AS query_group",
		);
		expect(INSPECT_QUERIES["stalled-queries"]).toMatchObject({
			scope: "compute",
			describe: expect.stringContaining("Oldest groups first"),
			sql: expect.stringContaining(
				"backend_type IN ('client backend', 'parallel worker')",
			),
			fields: [
				"duration",
				"wait_event",
				"blocking_pids",
				"role",
				"query_group",
				"query",
			],
		});
	});

	test("stalled-queries prints every declared field at full width", () => {
		const output = stripAnsi(captureWriter("table", 80));

		expect(output).toContain("Duration");
		expect(output).toContain("Wait Event");
		expect(output).not.toContain("Blocking Pids");
		expect(output).toContain("Role");
		expect(output).toContain("Query Group");
		expect(output).toContain("Query");
		expect(output).toContain(STALLED_QUERY_ROW.query);
		expect(output).not.toContain("...");
		expect(output).not.toMatch(
			/Observed At|Query Start|Leader Pid|Backend Type|Database|Application Name|Query Id|Wait Event Type/,
		);
		expect(output.trimEnd().split("\n")).toHaveLength(2);
		expect(stripAnsi(captureWriter("table", 40))).toBe(output);
	});

	test("stalled-queries shows blocking pids when a backend is waiting", () => {
		const output = stripAnsi(
			captureWriter("table", 80, [BLOCKED_STALLED_QUERY_ROW]),
		);

		expect(output).toContain("Blocking Pids");
		expect(output).toContain("771");
		expect(output).toContain(STALLED_QUERY_ROW.query);
		expect(output.trimEnd().split("\n")).toHaveLength(2);
	});

	test("stalled-queries JSON keeps every SQL field", () => {
		expect(JSON.parse(captureWriter("json"))).toEqual([STALLED_QUERY_ROW]);
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
