import type {
	ProjectBranchLogRecord,
	ProjectBranchLogSeverity,
	ProjectBranchLogSource,
	ProjectBranchLogsQueryRequest,
} from "@neon/sdk";
import type yargs from "yargs";
import { isNeonApiError } from "../api.js";
import { log } from "../log.js";
import type { BranchScopeProps } from "../types.js";
import { branchIdFromProps, fillSingleProject } from "../utils/enrichers.js";
import { noPassthrough, single } from "../utils/flags.js";
import { writer } from "../writer.js";

const BETA_NOTE =
	"Logs require Neon Platform Beta and are currently available only for projects in aws-us-east-2.";
const LOGS_EPILOG = `
${BETA_NOTE}

For more information, visit https://neon.com/docs/reference/neon-cli`;

// `satisfies` fails the build if a value here leaves the SDK's union, so the CLI
// can never offer a source or severity the API rejects.
const LOG_SOURCES = [
	"function",
	"storage",
	"pg_endpoint",
] as const satisfies readonly ProjectBranchLogSource[];

const LOG_SORT_ORDERS = ["asc", "desc"] as const satisfies readonly NonNullable<
	ProjectBranchLogsQueryRequest["sort_order"]
>[];

const LOG_SEVERITIES = [
	"trace",
	"debug",
	"info",
	"warn",
	"error",
	"fatal",
] as const satisfies readonly ProjectBranchLogSeverity[];

const LOG_FIELDS = [
	"timestamp",
	"source",
	"service_name",
	"severity_text",
	"message",
] as const satisfies readonly (keyof ProjectBranchLogRecord)[];

export const escapeLogTableCell = (value: string): string =>
	value.replace(/\p{Cc}/gu, (character) =>
		character === "\n" || character === "\t"
			? character
			: `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
	);

export const escapeLogSingleLine = (value: string): string =>
	value.replace(
		/\p{Cc}/gu,
		(character) =>
			`\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`,
	);

const shellQuoteLogValue = (value: string): string =>
	`'${escapeLogSingleLine(value).replace(/'/g, "'\\''")}'`;

export const assertReachableLogsPage = ({
	is_truncated,
	next_cursor,
}: {
	is_truncated: boolean;
	next_cursor?: string;
}): void => {
	if (is_truncated && !next_cursor) {
		throw new Error(
			"Neon returned an incomplete logs page without a pagination cursor. No records were printed because the result cannot be completed; retry the command.",
		);
	}
};

const logLimit = (value: unknown): number | undefined => {
	if (value === undefined) return undefined;
	if (
		Array.isArray(value) ||
		typeof value !== "number" ||
		!Number.isInteger(value) ||
		value < 1 ||
		value > 1000
	) {
		throw new Error("--limit must be an integer from 1 to 1000.");
	}
	return value;
};

// The structured content filters. `--logql` replaces all of them, so supplying
// both is rejected before the request. The window, limit, sort order and cursor
// bound the query rather than form part of the selection, so they combine with
// `--logql` freely.
const CONTENT_FILTERS = [
	"source",
	"service-name",
	"scope-name",
	"minimum-severity",
	"severity-text",
	"body-contains",
	"trace-id",
] as const;

const scopeOptions = {
	"project-id": {
		describe: "Project ID",
		type: "string",
		coerce: single("project-id"),
	},
	branch: {
		describe: "Branch ID or name",
		type: "string",
		coerce: single("branch"),
	},
} as const;

const windowOptions = (defaultWindow: "1h" | "6h") =>
	({
		since: {
			describe: `Length of the window, ending at --end-time or now. Defaults to ${defaultWindow}; the maximum window is 7d. Mutually exclusive with --start-time.`,
			type: "string",
			coerce: single("since"),
		},
		"start-time": {
			describe:
				"Inclusive start of the window (RFC 3339, e.g. 2025-01-01T00:00:00Z). The maximum window is 7d. Mutually exclusive with --since.",
			type: "string",
			coerce: single("start-time"),
		},
		"end-time": {
			describe:
				"Exclusive end of the window (RFC 3339). Defaults to the current time.",
			type: "string",
			coerce: single("end-time"),
		},
	}) as const;

export const command = "logs";
export const describe = "Query branch logs";

export const builder = (argv: yargs.Argv) =>
	argv
		.usage("$0 logs <sub-command> [options]")
		.options(scopeOptions)
		.middleware(fillSingleProject as any)
		.command(
			"query",
			"Query log records on a branch",
			(yargs) =>
				yargs
					.epilogue(LOGS_EPILOG)
					.options({
						...windowOptions("1h"),
						limit: {
							describe:
								"Maximum number of records to return per page (1-1000)",
							type: "number",
							default: 100,
							coerce: logLimit,
						},
						cursor: {
							describe:
								"Pagination cursor returned as next_cursor by a previous call. Repeat the same time range and filters.",
							type: "string",
							coerce: single("cursor"),
						},
						"sort-order": {
							describe:
								"Order records by timestamp. Defaults to desc (newest first).",
							type: "string",
							choices: LOG_SORT_ORDERS,
							coerce: single("sort-order"),
						},
						source: {
							describe: "Only records emitted by this service",
							type: "string",
							choices: LOG_SOURCES,
							coerce: single("source"),
						},
						"service-name": {
							describe:
								"Match the OpenTelemetry service.name resource attribute exactly",
							type: "string",
							coerce: single("service-name"),
						},
						"scope-name": {
							describe:
								"Match the OpenTelemetry instrumentation scope name exactly",
							type: "string",
							coerce: single("scope-name"),
						},
						"minimum-severity": {
							describe:
								"Only records at or above this severity. Combines with --severity-text. If Neon reports that this filter is unsupported, use --severity-text instead.",
							type: "string",
							choices: LOG_SEVERITIES,
							coerce: single("minimum-severity"),
						},
						"severity-text": {
							describe:
								"Match the OpenTelemetry severity text exactly. Run `neon logs field-values severity_text` to discover the values present.",
							type: "string",
							coerce: single("severity-text"),
						},
						"body-contains": {
							describe:
								"Match the case-sensitive rendered message. Structured bodies are rendered as compact JSON.",
							type: "string",
							coerce: single("body-contains"),
						},
						"trace-id": {
							describe:
								"Match records carrying this trace ID (32 lowercase hex digits)",
							type: "string",
							coerce: single("trace-id"),
						},
						logql: {
							describe:
								"Raw LogQL expression (stream selectors and line filters only). Replaces the structured filters; the window, --limit, --sort-order and --cursor still apply.",
							type: "string",
							coerce: single("logql"),
						},
					})
					.conflicts("since", "start-time")
					.conflicts("logql", [...CONTENT_FILTERS])
					.example([
						[
							"$0 logs query --since 30m",
							"The last 30 minutes of logs on the default branch",
						],
						[
							"$0 logs query --branch main --source pg_endpoint --minimum-severity error",
							"Postgres compute errors on main",
						],
						[
							'$0 logs query --since 1h --logql \'{entity_type="function"} |= "timeout"\'',
							"A raw LogQL selection instead of the structured filters",
						],
					])
					.strict()
					.check(noPassthrough("logs query")),
			(args) => query(args as any),
		)
		.command(
			"fields",
			"List the log fields whose values can be discovered on a branch",
			(yargs) =>
				yargs
					.epilogue(LOGS_EPILOG)
					.strict()
					.check(noPassthrough("logs fields")),
			(args) => fields(args as any),
		)
		.command(
			"field-values <field>",
			"List the distinct values observed for a log field",
			(yargs) =>
				yargs
					.epilogue(LOGS_EPILOG)
					.positional("field", {
						describe:
							"The log field to list values for. Must be one of the names `logs fields` reports.",
						type: "string",
						demandOption: true,
					})
					.options({
						...windowOptions("6h"),
						source: {
							describe:
								"Only consider records emitted by this service",
							type: "string",
							choices: LOG_SOURCES,
							coerce: single("source"),
						},
						limit: {
							describe:
								"Maximum number of distinct values to return (1-1000)",
							type: "number",
							coerce: logLimit,
						},
					})
					.conflicts("since", "start-time")
					.example([
						[
							"$0 logs field-values service_name --since 6h",
							"Service names seen in the last six hours",
						],
					])
					.strict()
					.check(noPassthrough("logs field-values")),
			(args) => fieldValues(args as any),
		)
		.demandCommand(1, "Run `neon logs --help` to see the subcommands.")
		.epilogue(LOGS_EPILOG);

export const handler = (args: yargs.Argv) => {
	return args;
};

export type LogsQueryFlags = {
	since?: string;
	startTime?: string;
	endTime?: string;
	limit?: number;
	cursor?: string;
	sortOrder?: (typeof LOG_SORT_ORDERS)[number];
	source?: ProjectBranchLogSource;
	serviceName?: string;
	scopeName?: string;
	minimumSeverity?: ProjectBranchLogSeverity;
	severityText?: string;
	bodyContains?: string;
	traceId?: string;
	logql?: string;
};

/**
 * Map the parsed flags onto the request body, dropping everything the user did
 * not supply so the API applies its own defaults rather than ours.
 */
export const buildLogsQueryBody = (
	flags: LogsQueryFlags,
): ProjectBranchLogsQueryRequest => {
	const body: ProjectBranchLogsQueryRequest = {};
	if (flags.since !== undefined) body.since = flags.since;
	if (flags.startTime !== undefined) body.start_time = flags.startTime;
	if (flags.endTime !== undefined) body.end_time = flags.endTime;
	if (flags.limit !== undefined) body.limit = flags.limit;
	if (flags.cursor !== undefined) body.cursor = flags.cursor;
	if (flags.sortOrder !== undefined) body.sort_order = flags.sortOrder;
	if (flags.source !== undefined) body.source = flags.source;
	if (flags.serviceName !== undefined) body.service_name = flags.serviceName;
	if (flags.scopeName !== undefined) body.scope_name = flags.scopeName;
	if (flags.minimumSeverity !== undefined) {
		body.minimum_severity = flags.minimumSeverity;
	}
	if (flags.severityText !== undefined) {
		body.severity_text = flags.severityText;
	}
	if (flags.bodyContains !== undefined) {
		body.body_contains = flags.bodyContains;
	}
	if (flags.traceId !== undefined) body.trace_id = flags.traceId;
	if (flags.logql !== undefined) body.logql = flags.logql;
	return body;
};

const describeWindow = (
	window: { since?: string; startTime?: string; endTime?: string },
	defaultSince: "1h" | "6h",
): string =>
	window.startTime
		? `window from ${window.startTime} to ${window.endTime ?? "now"}`
		: `${window.since ?? defaultSince} window ending ${window.endTime ?? "now"}`;

const apiErrorReason = (data: unknown): string | undefined => {
	if (typeof data !== "object" || data === null || !("reason" in data)) {
		return undefined;
	}
	return typeof data.reason === "string" ? data.reason : undefined;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

const isOptionalString = (value: unknown): value is string | undefined =>
	value === undefined || typeof value === "string";

const isProjectBranchLogRecord = (
	value: unknown,
): value is ProjectBranchLogRecord =>
	isRecord(value) &&
	typeof value.timestamp === "string" &&
	!Number.isNaN(Date.parse(value.timestamp)) &&
	typeof value.message === "string" &&
	(value.source === undefined ||
		LOG_SOURCES.some((source) => source === value.source)) &&
	isOptionalString(value.entity_id) &&
	isOptionalString(value.service_name) &&
	isOptionalString(value.scope_name) &&
	isOptionalString(value.severity_text) &&
	(value.severity_number === undefined ||
		(typeof value.severity_number === "number" &&
			Number.isInteger(value.severity_number) &&
			value.severity_number >= 0 &&
			value.severity_number <= 24)) &&
	isOptionalString(value.trace_id) &&
	isOptionalString(value.span_id) &&
	isRecord(value.attributes);

function assertLogsQueryResponse(value: unknown): asserts value is {
	logs: ProjectBranchLogRecord[];
	next_cursor?: string;
	is_truncated: boolean;
} {
	if (
		!isRecord(value) ||
		!Array.isArray(value.logs) ||
		!value.logs.every(isProjectBranchLogRecord) ||
		!isOptionalString(value.next_cursor) ||
		typeof value.is_truncated !== "boolean"
	) {
		throw new Error(
			"Neon returned an invalid logs query response; expected logs[] and is_truncated.",
		);
	}
}

function assertLogFieldsResponse(
	value: unknown,
): asserts value is { fields: string[] } {
	if (
		!isRecord(value) ||
		!Array.isArray(value.fields) ||
		!value.fields.every((field) => typeof field === "string")
	) {
		throw new Error(
			"Neon returned an invalid log fields response; expected fields[].",
		);
	}
}

function assertLogFieldValuesResponse(
	value: unknown,
): asserts value is { values: string[]; is_truncated: boolean } {
	if (
		!isRecord(value) ||
		!Array.isArray(value.values) ||
		!value.values.every((field) => typeof field === "string") ||
		typeof value.is_truncated !== "boolean"
	) {
		throw new Error(
			"Neon returned an invalid log field-values response; expected values[] and is_truncated.",
		);
	}
}

const query = async (
	props: BranchScopeProps & LogsQueryFlags,
): Promise<void> => {
	const branchId = await branchIdFromProps(props);
	const { data } = await props.apiClient.queryProjectBranchLogs(
		props.projectId,
		branchId,
		buildLogsQueryBody(props),
	);

	assertLogsQueryResponse(data);
	assertReachableLogsPage(data);

	if (props.output === "json" || props.output === "yaml") {
		writer(props).end(data, {
			fields: ["logs", "next_cursor", "is_truncated"],
		});
		return;
	}

	writer(props).end(
		data.logs.map((record) => ({
			timestamp: escapeLogTableCell(record.timestamp),
			source:
				record.source === undefined
					? undefined
					: escapeLogTableCell(record.source),
			service_name:
				record.service_name === undefined
					? undefined
					: escapeLogTableCell(record.service_name),
			severity_text:
				record.severity_text === undefined
					? undefined
					: escapeLogTableCell(record.severity_text),
			message: escapeLogTableCell(record.message),
		})),
		{
			fields: LOG_FIELDS,
			title: "logs",
			emptyMessage: `No logs found in the ${describeWindow(props, "1h")}.`,
		},
	);

	// Guidance goes to stderr, and only in table mode: stdout carries the
	// machine-readable envelope and must stay parseable.
	if (data.is_truncated && data.next_cursor) {
		log.info(
			`More logs matched than were returned. Re-run with the same filters plus --cursor ${shellQuoteLogValue(data.next_cursor)} to fetch the next page.`,
		);
	}
};

const fields = async (props: BranchScopeProps): Promise<void> => {
	const branchId = await branchIdFromProps(props);
	const { data } = await props.apiClient.listProjectBranchLogFields(
		props.projectId,
		branchId,
	);

	assertLogFieldsResponse(data);

	if (props.output === "json" || props.output === "yaml") {
		writer(props).end(data, { fields: ["fields"] });
		return;
	}

	writer(props).end(
		data.fields.map((field) => ({ field: escapeLogTableCell(field) })),
		{
			fields: ["field"],
			title: "fields",
			emptyMessage: "No log fields found.",
		},
	);
};

const fieldValues = async (
	props: BranchScopeProps & {
		field: string;
		since?: string;
		startTime?: string;
		endTime?: string;
		source?: ProjectBranchLogSource;
		limit?: number;
	},
): Promise<void> => {
	const branchId = await branchIdFromProps(props);
	let data;
	try {
		({ data } = await props.apiClient.listProjectBranchLogFieldValues({
			projectId: props.projectId,
			branchId,
			fieldName: props.field,
			...(props.since !== undefined ? { since: props.since } : {}),
			...(props.startTime !== undefined
				? { start_time: props.startTime }
				: {}),
			...(props.endTime !== undefined ? { end_time: props.endTime } : {}),
			...(props.source !== undefined ? { source: props.source } : {}),
			...(props.limit !== undefined ? { limit: props.limit } : {}),
		}));
	} catch (error) {
		if (
			isNeonApiError(error) &&
			error.status === 400 &&
			apiErrorReason(error.data) === "unknown_field"
		) {
			throw new Error(
				`Unknown log field "${escapeLogSingleLine(props.field)}". Run \`neon logs fields --project-id ${escapeLogSingleLine(props.projectId)} --branch ${escapeLogSingleLine(branchId)}\` to list the fields this branch supports.`,
			);
		}
		throw error;
	}

	assertLogFieldValuesResponse(data);

	if (props.output === "json" || props.output === "yaml") {
		writer(props).end(data, { fields: ["values", "is_truncated"] });
		return;
	}

	writer(props).end(
		data.values.map((value) => ({ value: escapeLogTableCell(value) })),
		{
			fields: ["value"],
			title: "values",
			emptyMessage: `No values found in the ${describeWindow(props, "6h")}.`,
		},
	);

	if (data.is_truncated) {
		log.info(
			`More values exist than were returned for "${escapeLogSingleLine(props.field)}". Narrow the window with --since or --start-time, restrict --source, or raise --limit, then run it again.`,
		);
	}
};
