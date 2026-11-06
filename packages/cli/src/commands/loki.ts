import type yargs from "yargs";
import { DEFAULT_API_HOST, NeonApiError } from "../api.js";
import type { BranchScopeProps } from "../types.js";
import { branchIdFromProps } from "../utils/enrichers.js";
import { noPassthrough, single } from "../utils/flags.js";
import { writer } from "../writer.js";

type LokiProps = BranchScopeProps & {
	query?: string;
	endpoint: string;
	since?: string;
	start?: string;
	end?: string;
	limit?: number;
	direction?: "forward" | "backward";
};

const LABEL_VALUES = /^label\/([a-zA-Z_][a-zA-Z0-9_]*)\/values$/;

const endpoint = (value: unknown): string => {
	const path = single("endpoint")(value);
	if (
		path === undefined ||
		!(
			path === "query_range" ||
			path === "labels" ||
			LABEL_VALUES.test(path)
		)
	) {
		throw new Error(
			"--endpoint must be query_range, labels, or label/<name>/values. See neon logs loki --help.",
		);
	}
	return path;
};

const limit = (value: unknown): number | undefined => {
	if (value === undefined) return undefined;
	if (
		typeof value !== "number" ||
		!Number.isSafeInteger(value) ||
		value < 1
	) {
		throw new Error("--limit must be a positive integer.");
	}
	return value;
};

const rangeQuery = ({ query }: LokiProps): string => {
	if (!query?.trim()) {
		throw new Error(
			"Pass a LogQL query, e.g. neon logs loki '{entity_type=\"function\"}'. See neon logs loki --help.",
		);
	}
	return query;
};

const validate = (props: LokiProps) => {
	if (props.endpoint === "query_range") {
		rangeQuery(props);
		return;
	}
	for (const name of ["limit", "direction"] as const) {
		if (props[name] !== undefined) {
			throw new Error(
				`--${name} applies only to --endpoint query_range.`,
			);
		}
	}
};

export const command = "loki [query]";
export const describe =
	"Call the branch's Loki read API and return its JSON response";

export const builder = (argv: yargs.Argv) =>
	argv
		.usage("$0 logs loki [query] [options]")
		.positional("query", {
			describe:
				"LogQL expression. With a label endpoint, an optional stream selector that scopes the labels.",
			type: "string",
			coerce: single("query"),
		})
		.options({
			"project-id": {
				describe: "Project ID",
				type: "string",
				coerce: single("project-id"),
			},
			branch: {
				describe:
					"Branch ID or name (defaults to the project's default branch)",
				type: "string",
				coerce: single("branch"),
			},
			since: {
				describe:
					"Lookback window as a positive Go duration, e.g. 30m or 24h. Defaults to 1h for queries and 6h for label values. Explicit --start takes precedence.",
				type: "string",
				coerce: single("since"),
			},
			start: {
				describe:
					"Window start as RFC 3339 or Unix nanoseconds (kept as a string)",
				type: "string",
				coerce: single("start"),
			},
			end: {
				describe:
					"Window end as RFC 3339 or Unix nanoseconds (kept as a string). Defaults to now.",
				type: "string",
				coerce: single("end"),
			},
			limit: {
				describe:
					"Maximum number of log lines (query_range only); the server enforces its cap",
				type: "number",
				coerce: limit,
			},
			direction: {
				describe:
					"Timestamp order (query_range only): forward (oldest first) or backward (newest first)",
				type: "string",
				choices: ["forward", "backward"],
				coerce: single("direction"),
			},
			endpoint: {
				describe:
					"Read endpoint: query_range, labels, or label/<name>/values",
				type: "string",
				default: "query_range",
				coerce: endpoint,
			},
		})
		.default("output", "json")
		.middleware((args) => {
			noPassthrough("logs loki")(args);
			if (args.output !== "json" && args.output !== "yaml") {
				throw new Error(
					"--output must be json or yaml for neon logs loki.",
				);
			}
			validate(args as unknown as LokiProps);
		}, true)
		.strict()
		.example(
			'$0 logs loki \'{entity_type="function"} |= "error"\' --since 30m --limit 100',
			"Query function logs with a bounded time window and line count",
		)
		.example("$0 logs loki --endpoint labels", "Discover stream labels")
		.example(
			"$0 logs loki --endpoint label/service_name/values --since 6h",
			"Discover service names before choosing a selector",
		)
		.example(
			"$0 logs loki '{entity_type=\"function\"}' --endpoint label/severity_text/values",
			"List the severities function logs carry",
		)
		.example(
			"$0 logs loki '{entity_type=\"function\"}' --project-id <id> --branch <id|name> --start 2026-11-01T00:00:00Z --end 2026-11-01T01:00:00Z",
			"Query an explicit branch and absolute time window",
		)
		.epilogue(
			[
				"query_range requires a LogQL query and accepts --since, --start, --end, --limit and --direction. labels and label/<name>/values accept the time bounds and an optional stream selector without line filters. Use entity_type, not source, in Loki selectors.",
				"Output: --output json (default) or --output yaml. data.result groups lines by stream labels; each values entry is [timestamp, line], with timestamps kept as nanosecond strings. There is no continuation cursor: a result with --limit lines, or the server's cap of 10,000, may be incomplete, and the cap adds no warnings entry. Narrow the time window or selector to retrieve complete results.",
				"Neon supports stream selectors and line filters; metric queries, parser stages and live tailing are unsupported. Instant queries are unsupported.",
				"For structured filters, human-readable tables and cursor pagination, use neon logs query --help.",
				"Uses /telemetry/v1 on the origin selected by --api-host or NEON_API_HOST. Availability depends on the project's region and telemetry rollout. See https://neon.com/docs/cli/logs#loki-read-api",
			].join("\n\n"),
		);

export const handler = async (props: LokiProps) => {
	const branchId = await branchIdFromProps(props);
	const { fromSdkError, getNeonClient } = await import("../neon_client.js");
	const { loki } = getNeonClient(props).logs;
	const scope = {
		projectId: props.projectId,
		branchId,
		since: props.since,
		start: props.start,
		end: props.end,
	};
	const label = LABEL_VALUES.exec(props.endpoint)?.[1];
	const request =
		props.endpoint === "query_range"
			? loki.queryRange({
					...scope,
					query: rangeQuery(props),
					limit: props.limit,
					direction: props.direction,
				})
			: label === undefined
				? loki.labels({ ...scope, query: props.query })
				: loki.labelValues({
						...scope,
						name: label,
						query: props.query,
					});
	const data = await request.catch((error: unknown) => {
		const failure = fromSdkError(
			error,
			new URL(
				"/telemetry/v1",
				props.apiHost ?? DEFAULT_API_HOST,
			).toString(),
		);
		if (!(failure instanceof NeonApiError)) throw failure;
		// Loki quotes the rejected LogQL in its error text, and the message goes to error
		// analytics. The top-level handler prints the server's text from `data`.
		throw new NeonApiError(
			`Loki request failed with status ${failure.status}`,
			{
				status: failure.status,
				statusText: failure.statusText,
				data: failure.data,
				headers: failure.headers,
				requestPath: failure.requestPath,
			},
		);
	});
	writer({ output: props.output }).end(data, { fields: [] });
};
