import type {
	ProjectBranchLogRecord,
	ProjectBranchLogSeverity,
	ProjectBranchLogSource,
	ProjectBranchLogsQueryRequest,
} from "@neon/sdk";
import type yargs from "yargs";
import { log } from "../log.js";
import type { BranchScopeProps } from "../types.js";
import { branchIdFromProps, fillSingleProject } from "../utils/enrichers.js";
import { writer } from "../writer.js";

const BETA_NOTE =
	"Logs require Neon Platform Beta and are currently available only for projects in aws-us-east-2.";
const LOGS_EPILOG = `${BETA_NOTE}

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

export const assertReachableLogsPage = ({
	is_truncated,
	next_cursor,
}: {
	is_truncated: boolean;
	next_cursor?: string;
}): void => {
	if (is_truncated && !next_cursor) {
		throw new Error(
			"Neon reported more log records than it returned but gave no cursor to reach them.",
		);
	}
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
	},
	branch: {
		describe: "Branch ID or name",
		type: "string",
	},
} as const;

const windowOptions = {
	since: {
		describe:
			"Length of the window, ending at --end-time or now (e.g. 30m, 6h, 7d). Mutually exclusive with --start-time.",
		type: "string",
	},
	"start-time": {
		describe:
			"Inclusive start of the window (RFC 3339, e.g. 2025-01-01T00:00:00Z). Mutually exclusive with --since.",
		type: "string",
	},
	"end-time": {
		describe:
			"Exclusive end of the window (RFC 3339). Defaults to the current time.",
		type: "string",
	},
} as const;

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
						...windowOptions,
						limit: {
							describe:
								"Maximum number of records to return per page",
							type: "number",
							default: 100,
						},
						cursor: {
							describe:
								"Pagination cursor returned as next_cursor by a previous call. Repeat the same time range and filters.",
							type: "string",
						},
						"sort-order": {
							describe:
								"Order records by timestamp. Defaults to desc (newest first).",
							type: "string",
							choices: LOG_SORT_ORDERS,
						},
						source: {
							describe: "Only records emitted by this service",
							type: "string",
							choices: LOG_SOURCES,
						},
						"service-name": {
							describe:
								"Match the OpenTelemetry service.name resource attribute exactly",
							type: "string",
						},
						"scope-name": {
							describe:
								"Match the OpenTelemetry instrumentation scope name exactly",
							type: "string",
						},
						"minimum-severity": {
							describe:
								"Only records at or above this severity. Combines with --severity-text. Some branch log backends reject this filter; use --severity-text when they do.",
							type: "string",
							choices: LOG_SEVERITIES,
						},
						"severity-text": {
							describe:
								"Match the OpenTelemetry severity text exactly",
							type: "string",
						},
						"body-contains": {
							describe:
								"Match records whose rendered message contains this case-sensitive substring",
							type: "string",
						},
						"trace-id": {
							describe:
								"Match records carrying this trace ID (32 lowercase hex digits)",
							type: "string",
						},
						logql: {
							describe:
								"Raw LogQL expression (stream selectors and line filters only). Replaces the structured filters; the window, --limit, --sort-order and --cursor still apply.",
							type: "string",
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
					]),
			(args) => query(args as any),
		)
		.command(
			"fields",
			"List the log fields whose values can be discovered on a branch",
			(yargs) => yargs.epilogue(LOGS_EPILOG),
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
						...windowOptions,
						source: {
							describe:
								"Only consider records emitted by this service",
							type: "string",
							choices: LOG_SOURCES,
						},
						limit: {
							describe:
								"Maximum number of distinct values to return",
							type: "number",
						},
					})
					.conflicts("since", "start-time")
					.example([
						[
							"$0 logs field-values service_name --since 6h",
							"Service names seen in the last six hours",
						],
					]),
			(args) => fieldValues(args as any),
		)
		.demandCommand(1, "Specify a logs sub-command.")
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

const query = async (
	props: BranchScopeProps & LogsQueryFlags,
): Promise<void> => {
	const branchId = await branchIdFromProps(props);
	const { data } = await props.apiClient.queryProjectBranchLogs(
		props.projectId,
		branchId,
		buildLogsQueryBody(props),
	);

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
			emptyMessage: "No logs found.",
		},
	);

	// Guidance goes to stderr, and only in table mode: stdout carries the
	// machine-readable envelope and must stay parseable.
	if (data.is_truncated && data.next_cursor) {
		log.info(
			`More logs matched than were returned. Re-run with the same filters plus --cursor ${data.next_cursor} to fetch the next page.`,
		);
	}
};

const fields = async (props: BranchScopeProps): Promise<void> => {
	const branchId = await branchIdFromProps(props);
	const { data } = await props.apiClient.listProjectBranchLogFields(
		props.projectId,
		branchId,
	);

	if (props.output === "json" || props.output === "yaml") {
		writer(props).end(data, { fields: ["fields"] });
		return;
	}

	writer(props).end(
		data.fields.map((field) => ({ field })),
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
	const { data } = await props.apiClient.listProjectBranchLogFieldValues({
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
	});

	if (props.output === "json" || props.output === "yaml") {
		writer(props).end(data, { fields: ["values", "is_truncated"] });
		return;
	}

	writer(props).end(
		data.values.map((value) => ({ value })),
		{
			fields: ["value"],
			title: "values",
			emptyMessage: "No values found.",
		},
	);

	if (data.is_truncated) {
		log.info(
			`More values exist than were returned for "${props.field}". Narrow the window with --since or --start-time, restrict --source, or raise --limit, then run it again.`,
		);
	}
};
