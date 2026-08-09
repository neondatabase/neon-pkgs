import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect } from "vitest";
import { test } from "../test_utils/fixtures";
import {
	assertReachableLogsPage,
	escapeLogSingleLine,
	escapeLogTableCell,
} from "./logs.js";

// The mocks write the request they received to the file named by these env
// vars, which they read in the (parent) mock-server process. That is how a test
// asserts the wire shape of a request without the response echoing it back and
// polluting the documented envelope.
const TEST_TMP = mkdtempSync(join(tmpdir(), "neonctl-logs-"));
afterAll(() => {
	rmSync(TEST_TMP, { recursive: true, force: true });
});

afterEach(() => {
	delete process.env.NEONCTL_TEST_LOGS_QUERY_SINK;
	delete process.env.NEONCTL_TEST_LOGS_FIELD_VALUES_SINK;
});

const SCOPE = [
	"--project-id",
	"test-project-123456",
	"--branch",
	"main",
] as const;

// Branches whose mocks return the states that are otherwise unreachable from a
// single fixture: nothing matched, and more matched than was returned.
const EMPTY_BRANCH = ["--branch", "br-empty-logs-123456"] as const;
const TRUNCATED_BRANCH = ["--branch", "br-truncated-logs-123456"] as const;
const CONTROL_BRANCH = ["--branch", "br-control-logs-123456"] as const;
const CONTROL_CURSOR_BRANCH = ["--branch", "br-control-cursor-123456"] as const;
const BROKEN_PAGE_BRANCH = ["--branch", "br-broken-page-123456"] as const;
const MALFORMED_BRANCH = ["--branch", "br-malformed-logs-123456"] as const;
const PROJECT = ["--project-id", "test-project-123456"] as const;

describe("logs", () => {
	test("table cells neutralize terminal control sequences", () => {
		expect(
			escapeLogTableCell("\u001b]52;c;ZXZpbA==\u0007request failed\r"),
		).toBe("\\u001b]52;c;ZXZpbA==\\u0007request failed\\u000d");
	});

	test("single-line output neutralizes every control sequence", () => {
		expect(
			escapeLogSingleLine("\u001b]52;c;ZXZpbA==\u0007next\npage\t"),
		).toBe("\\u001b]52;c;ZXZpbA==\\u0007next\\u000apage\\u0009");
	});

	test("a truncated page without a cursor is rejected", () => {
		expect(() =>
			assertReachableLogsPage({
				is_truncated: true,
				next_cursor: "",
			}),
		).toThrow(
			"Neon returned an incomplete logs page without a pagination cursor. No records were printed because the result cannot be completed; retry the command.",
		);
	});

	test("the command group help states the Beta and region constraint", async ({
		testCliCommand,
	}) => {
		await testCliCommand(["logs", "--help"], {
			mockDir: "single_org",
			stderr: expect.stringContaining(
				"Logs require Neon Platform Beta and are currently available only for projects in aws-us-east-2.",
			),
		});
	});

	test("query help states the Beta and region constraint", async ({
		testCliCommand,
	}) => {
		await testCliCommand(["logs", "query", "--help"], {
			mockDir: "single_org",
			stderr: expect.stringContaining(
				"Logs require Neon Platform Beta and are currently available only for projects in aws-us-east-2.",
			),
		});
	});

	test("query help states the minimum-severity backend limitation", async ({
		testCliCommand,
	}) => {
		await testCliCommand(["logs", "query", "--help"], {
			mockDir: "single_org",
			stderr: expect.stringContaining(
				"If Neon reports that this filter is unsupported",
			),
		});
	});

	test("help states the default windows and seven-day cap", async ({
		testCliCommand,
	}) => {
		await testCliCommand(["logs", "query", "--help"], {
			mockDir: "single_org",
			stderr: expect.stringContaining(
				"Defaults to 1h; the maximum window is 7d.",
			),
		});
		await testCliCommand(["logs", "field-values", "--help"], {
			mockDir: "single_org",
			stderr: expect.stringContaining(
				"Defaults to 6h; the maximum window is 7d.",
			),
		});
	});

	test("a sub-command is required", async ({ testCliCommand }) => {
		await testCliCommand(["logs"], {
			mockDir: "single_org",
			code: 1,
			stderr: "ERROR: Run `neon logs --help` to see the subcommands.",
		});
	});

	test("an unknown sub-command is rejected", async ({ testCliCommand }) => {
		await testCliCommand(["logs", "definitely-not-a-subcommand"], {
			mockDir: "single_org",
			code: 1,
			stderr: expect.stringContaining("Unknown command"),
		});
	});

	test("an unknown query option is rejected before any request", async ({
		testCliCommand,
	}) => {
		await testCliCommand(
			["logs", "query", "--serverity", "error", ...SCOPE],
			{
				mockDir: "single_org",
				code: 1,
				stderr: expect.stringContaining("Unknown argument: serverity"),
			},
		);
	});

	test("query (yaml)", async ({ testCliCommand }) => {
		await testCliCommand(["logs", "query", ...SCOPE], {
			mockDir: "single_org",
			stderr: "",
		});
	});

	test("query with table output", async ({ testCliCommand }) => {
		await testCliCommand(["logs", "query", ...SCOPE], {
			mockDir: "single_org",
			outputTable: true,
			stderr: "",
		});
	});

	// The default `--limit` is the only thing sent when no filter is given: the
	// API, not the CLI, owns every other default.
	test("query sends only the limit when no filters are given", async ({
		testCliCommand,
	}) => {
		const sink = join(TEST_TMP, "query-defaults.json");
		process.env.NEONCTL_TEST_LOGS_QUERY_SINK = sink;

		await testCliCommand(["logs", "query", ...SCOPE], {
			mockDir: "single_org",
		});

		expect(JSON.parse(readFileSync(sink, "utf8"))).toEqual({ limit: 100 });
	});

	test("query rejects an invalid or out-of-range limit", async ({
		testCliCommand,
	}) => {
		for (const value of ["abc", "0", "1001", "1.5"]) {
			await testCliCommand(
				["logs", "query", "--limit", value, ...SCOPE],
				{
					mockDir: "single_org",
					code: 1,
					stderr: expect.stringContaining(
						"--limit must be an integer from 1 to 1000.",
					),
				},
			);
		}
	});

	test("query rejects repeated scalar filters", async ({
		testCliCommand,
	}) => {
		await testCliCommand(
			["logs", "query", "--since", "1h", "--since", "2h", ...SCOPE],
			{
				mockDir: "single_org",
				code: 1,
				stderr: "ERROR: --since was given more than once. Pass it at most once.",
			},
		);
	});

	test("query maps every structured filter onto its wire name", async ({
		testCliCommand,
	}) => {
		const sink = join(TEST_TMP, "query-filters.json");
		process.env.NEONCTL_TEST_LOGS_QUERY_SINK = sink;

		await testCliCommand(
			[
				"logs",
				"query",
				"--since",
				"30m",
				"--end-time",
				"2025-01-01T01:00:00Z",
				"--limit",
				"25",
				"--cursor",
				"eyJvZmZzZXQiOjB9",
				"--sort-order",
				"asc",
				"--source",
				"pg_endpoint",
				"--service-name",
				"postgres",
				"--scope-name",
				"pgbouncer",
				"--minimum-severity",
				"warn",
				"--severity-text",
				"ERROR",
				"--body-contains",
				"connection",
				"--trace-id",
				"4bf92f3577b34da6a3ce929d0e0e4736",
				...SCOPE,
			],
			{ mockDir: "single_org" },
		);

		expect(JSON.parse(readFileSync(sink, "utf8"))).toEqual({
			since: "30m",
			end_time: "2025-01-01T01:00:00Z",
			limit: 25,
			cursor: "eyJvZmZzZXQiOjB9",
			sort_order: "asc",
			source: "pg_endpoint",
			service_name: "postgres",
			scope_name: "pgbouncer",
			minimum_severity: "warn",
			severity_text: "ERROR",
			body_contains: "connection",
			trace_id: "4bf92f3577b34da6a3ce929d0e0e4736",
		});
	});

	test("query sends an explicit start time instead of a duration", async ({
		testCliCommand,
	}) => {
		const sink = join(TEST_TMP, "query-start-time.json");
		process.env.NEONCTL_TEST_LOGS_QUERY_SINK = sink;

		await testCliCommand(
			[
				"logs",
				"query",
				"--start-time",
				"2025-01-01T00:00:00Z",
				"--end-time",
				"2025-01-01T01:00:00Z",
				...SCOPE,
			],
			{ mockDir: "single_org" },
		);

		expect(JSON.parse(readFileSync(sink, "utf8"))).toEqual({
			start_time: "2025-01-01T00:00:00Z",
			end_time: "2025-01-01T01:00:00Z",
			limit: 100,
		});
	});

	// `--logql` bounds still travel: the window, limit, sort order and cursor
	// bound the query rather than form part of the selection.
	test("query sends a raw LogQL expression alongside the window and limit", async ({
		testCliCommand,
	}) => {
		const sink = join(TEST_TMP, "query-logql.json");
		process.env.NEONCTL_TEST_LOGS_QUERY_SINK = sink;

		await testCliCommand(
			[
				"logs",
				"query",
				"--since",
				"1h",
				"--sort-order",
				"desc",
				"--logql",
				'{entity_type="function"} |= "timeout"',
				...SCOPE,
			],
			{ mockDir: "single_org" },
		);

		expect(JSON.parse(readFileSync(sink, "utf8"))).toEqual({
			since: "1h",
			sort_order: "desc",
			limit: 100,
			logql: '{entity_type="function"} |= "timeout"',
		});
	});

	test("query rejects --since together with --start-time", async ({
		testCliCommand,
	}) => {
		await testCliCommand(
			[
				"logs",
				"query",
				"--since",
				"1h",
				"--start-time",
				"2025-01-01T00:00:00Z",
				...SCOPE,
			],
			{
				mockDir: "single_org",
				code: 1,
				stderr: expect.stringContaining(
					"Arguments since and start-time are mutually exclusive",
				),
			},
		);
	});

	test("query rejects --logql together with a structured filter", async ({
		testCliCommand,
	}) => {
		await testCliCommand(
			[
				"logs",
				"query",
				"--logql",
				'{entity_type="function"}',
				"--source",
				"function",
				...SCOPE,
			],
			{
				mockDir: "single_org",
				code: 1,
				stderr: expect.stringContaining(
					"Arguments logql and source are mutually exclusive",
				),
			},
		);
	});

	test("query accepts --minimum-severity together with --severity-text", async ({
		testCliCommand,
	}) => {
		const sink = join(TEST_TMP, "query-severity.json");
		process.env.NEONCTL_TEST_LOGS_QUERY_SINK = sink;

		await testCliCommand(
			[
				"logs",
				"query",
				"--minimum-severity",
				"warn",
				"--severity-text",
				"ERROR",
				...SCOPE,
			],
			{ mockDir: "single_org" },
		);

		expect(JSON.parse(readFileSync(sink, "utf8"))).toEqual({
			minimum_severity: "warn",
			severity_text: "ERROR",
			limit: 100,
		});
	});

	test("query resolves the default branch when none is given", async ({
		testCliCommand,
	}) => {
		await testCliCommand(["logs", "query", ...PROJECT], {
			mockDir: "single_org",
			stderr: "",
		});
	});

	test("query resolves the single project when none is given", async ({
		testCliCommand,
	}) => {
		await testCliCommand(["logs", "query"], {
			mockDir: "single_org",
			stderr: "",
		});
	});

	test("query prints an empty-state message in table output", async ({
		testCliCommand,
	}) => {
		await testCliCommand(["logs", "query", ...PROJECT, ...EMPTY_BRANCH], {
			mockDir: "single_org",
			outputTable: true,
			stderr: "",
		});
	});

	test("query neutralizes terminal controls in table output", async ({
		testCliCommand,
	}) => {
		await testCliCommand(["logs", "query", ...PROJECT, ...CONTROL_BRANCH], {
			mockDir: "single_org",
			outputTable: true,
			stderr: "",
		});
	});

	test("query rejects a truncated page without a cursor", async ({
		testCliCommand,
	}) => {
		await testCliCommand(
			["logs", "query", ...PROJECT, ...BROKEN_PAGE_BRANCH],
			{
				mockDir: "single_org",
				code: 1,
				stderr: "ERROR: Neon returned an incomplete logs page without a pagination cursor. No records were printed because the result cannot be completed; retry the command.",
			},
		);
	});

	test("query rejects a malformed successful response", async ({
		testCliCommand,
	}) => {
		await testCliCommand(
			["logs", "query", ...PROJECT, ...MALFORMED_BRANCH],
			{
				mockDir: "single_org",
				output: "json",
				code: 1,
				stderr: "ERROR: Neon returned an invalid logs query response; expected logs[] and is_truncated.",
			},
		);
	});

	test("query neutralizes controls in pagination guidance", async ({
		testCliCommand,
	}) => {
		await testCliCommand(
			["logs", "query", ...PROJECT, ...CONTROL_CURSOR_BRANCH],
			{
				mockDir: "single_org",
				outputTable: true,
				stderr: "INFO: More logs matched than were returned. Re-run with the same filters plus --cursor '\\u001b]52;c;ZXZpbA==\\u0007$(echo unsafe)' to fetch the next page.",
			},
		);
	});

	test("a truncated query points at the next cursor in table output", async ({
		testCliCommand,
	}) => {
		await testCliCommand(
			["logs", "query", ...PROJECT, ...TRUNCATED_BRANCH],
			{
				mockDir: "single_org",
				outputTable: true,
				stderr: "INFO: More logs matched than were returned. Re-run with the same filters plus --cursor 'eyJvZmZzZXQiOjEwMH0' to fetch the next page.",
			},
		);
	});

	// The pagination guidance is for humans reading a table. JSON output is
	// piped, so stdout stays the envelope and nothing is written to stderr.
	test("a truncated query keeps json output clean and stderr empty", async ({
		testCliCommand,
	}) => {
		await testCliCommand(
			["logs", "query", ...PROJECT, ...TRUNCATED_BRANCH],
			{
				mockDir: "single_org",
				output: "json",
				stderr: "",
			},
		);
	});

	test("fields (yaml)", async ({ testCliCommand }) => {
		await testCliCommand(["logs", "fields", ...SCOPE], {
			mockDir: "single_org",
			stderr: "",
		});
	});

	test("fields with table output", async ({ testCliCommand }) => {
		await testCliCommand(["logs", "fields", ...SCOPE], {
			mockDir: "single_org",
			outputTable: true,
			stderr: "",
		});
	});

	test("fields prints an empty-state message in table output", async ({
		testCliCommand,
	}) => {
		await testCliCommand(["logs", "fields", ...PROJECT, ...EMPTY_BRANCH], {
			mockDir: "single_org",
			outputTable: true,
			stderr: "",
		});
	});

	test("fields neutralizes terminal controls in table output", async ({
		testCliCommand,
	}) => {
		await testCliCommand(
			["logs", "fields", ...PROJECT, ...CONTROL_BRANCH],
			{
				mockDir: "single_org",
				outputTable: true,
				stderr: "",
			},
		);
	});

	test("fields rejects a malformed successful response", async ({
		testCliCommand,
	}) => {
		await testCliCommand(
			["logs", "fields", ...PROJECT, ...MALFORMED_BRANCH],
			{
				mockDir: "single_org",
				output: "json",
				code: 1,
				stderr: "ERROR: Neon returned an invalid log fields response; expected fields[].",
			},
		);
	});

	test("field-values (yaml)", async ({ testCliCommand }) => {
		await testCliCommand(
			["logs", "field-values", "service_name", ...SCOPE],
			{
				mockDir: "single_org",
				stderr: "",
			},
		);
	});

	test("field-values with table output", async ({ testCliCommand }) => {
		await testCliCommand(
			["logs", "field-values", "service_name", ...SCOPE],
			{
				mockDir: "single_org",
				outputTable: true,
				stderr: "",
			},
		);
	});

	test("field-values neutralizes terminal controls in table output", async ({
		testCliCommand,
	}) => {
		await testCliCommand(
			[
				"logs",
				"field-values",
				"service_name",
				...PROJECT,
				...CONTROL_BRANCH,
			],
			{
				mockDir: "single_org",
				outputTable: true,
				stderr: "",
			},
		);
	});

	test("field-values forwards the field name, window, source and limit", async ({
		testCliCommand,
	}) => {
		const sink = join(TEST_TMP, "field-values.json");
		process.env.NEONCTL_TEST_LOGS_FIELD_VALUES_SINK = sink;

		await testCliCommand(
			[
				"logs",
				"field-values",
				"service_name",
				"--since",
				"6h",
				"--end-time",
				"2025-01-01T01:00:00Z",
				"--source",
				"function",
				"--limit",
				"10",
				...SCOPE,
			],
			{ mockDir: "single_org" },
		);

		expect(JSON.parse(readFileSync(sink, "utf8"))).toEqual({
			field_name: "service_name",
			query: {
				since: "6h",
				end_time: "2025-01-01T01:00:00Z",
				source: "function",
				limit: "10",
			},
		});
	});

	test("field-values rejects an invalid limit", async ({
		testCliCommand,
	}) => {
		await testCliCommand(
			[
				"logs",
				"field-values",
				"service_name",
				"--limit",
				"abc",
				...SCOPE,
			],
			{
				mockDir: "single_org",
				code: 1,
				stderr: expect.stringContaining(
					"--limit must be an integer from 1 to 1000.",
				),
			},
		);
	});

	test("field-values rejects a malformed successful response", async ({
		testCliCommand,
	}) => {
		await testCliCommand(
			[
				"logs",
				"field-values",
				"service_name",
				...PROJECT,
				...MALFORMED_BRANCH,
			],
			{
				mockDir: "single_org",
				output: "json",
				code: 1,
				stderr: "ERROR: Neon returned an invalid log field-values response; expected values[] and is_truncated.",
			},
		);
	});

	test("field-values rejects --since together with --start-time", async ({
		testCliCommand,
	}) => {
		await testCliCommand(
			[
				"logs",
				"field-values",
				"service_name",
				"--since",
				"6h",
				"--start-time",
				"2025-01-01T00:00:00Z",
				...SCOPE,
			],
			{
				mockDir: "single_org",
				code: 1,
				stderr: expect.stringContaining(
					"Arguments since and start-time are mutually exclusive",
				),
			},
		);
	});

	test("field-values surfaces the API's rejection of an unknown field", async ({
		testCliCommand,
	}) => {
		await testCliCommand(
			["logs", "field-values", "unknown-field", ...SCOPE],
			{
				mockDir: "single_org",
				code: 1,
				stderr: 'ERROR: Unknown log field "unknown-field". Run `neon logs fields --project-id test-project-123456 --branch br-main-branch-123456` to list the fields this branch supports.',
			},
		);
	});

	test("field-values does not map a server failure to an unknown field", async ({
		testCliCommand,
	}) => {
		await testCliCommand(
			["logs", "field-values", "server-failure", ...SCOPE],
			{
				mockDir: "single_org",
				code: 1,
				stderr: "ERROR: telemetry service unavailable",
			},
		);
	});

	test("field-values prints an empty-state message in table output", async ({
		testCliCommand,
	}) => {
		await testCliCommand(
			[
				"logs",
				"field-values",
				"service_name",
				...PROJECT,
				...EMPTY_BRANCH,
			],
			{
				mockDir: "single_org",
				outputTable: true,
				stderr: "",
			},
		);
	});

	test("a truncated field-values run says how to narrow the lookup", async ({
		testCliCommand,
	}) => {
		await testCliCommand(
			[
				"logs",
				"field-values",
				"service_name",
				...PROJECT,
				...TRUNCATED_BRANCH,
			],
			{
				mockDir: "single_org",
				outputTable: true,
				stderr: 'INFO: More values exist than were returned for "service_name". Narrow the window with --since or --start-time, restrict --source, or raise --limit, then run it again.',
			},
		);
	});

	test("field-values neutralizes controls in truncation guidance", async ({
		testCliCommand,
	}) => {
		await testCliCommand(
			[
				"logs",
				"field-values",
				"\u001b]52;c;ZXZpbA==\u0007service\nname",
				...PROJECT,
				...TRUNCATED_BRANCH,
			],
			{
				mockDir: "single_org",
				outputTable: true,
				stderr: 'INFO: More values exist than were returned for "\\u001b]52;c;ZXZpbA==\\u0007service\\u000aname". Narrow the window with --since or --start-time, restrict --source, or raise --limit, then run it again.',
			},
		);
	});

	test("a truncated field-values run keeps json output clean and stderr empty", async ({
		testCliCommand,
	}) => {
		await testCliCommand(
			[
				"logs",
				"field-values",
				"service_name",
				...PROJECT,
				...TRUNCATED_BRANCH,
			],
			{
				mockDir: "single_org",
				output: "json",
				stderr: "",
			},
		);
	});
});
