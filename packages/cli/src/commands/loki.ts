import type yargs from "yargs";
import { getApiClient, pathSegment } from "../api.js";
import type { BranchScopeProps } from "../types.js";
import { branchIdFromProps } from "../utils/enrichers.js";
import { noPassthrough, single } from "../utils/flags.js";
import { writer } from "../writer.js";

type LokiProps = BranchScopeProps & {
	query?: string;
	field?: string[];
	endpoint: string;
	since?: string;
	start?: string;
	end?: string;
	limit?: number;
	direction?: "forward" | "backward";
};

const endpoint = (value: unknown): string => {
	const path = single("endpoint")(value);
	if (
		path === undefined ||
		!(
			/^(query_range|labels)$/.test(path) ||
			/^label\/[a-zA-Z_][a-zA-Z0-9_]*\/values$/.test(path)
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

const parameters = (props: LokiProps) => {
	const query = new Map<string, string>();
	for (const field of props.field ?? []) {
		if (typeof field !== "string") {
			throw new Error(
				"Use -f key=value, or omit --field to send no parameters.",
			);
		}
		const separator = field.indexOf("=");
		if (separator < 1) {
			throw new Error(`Invalid field "${field}". Use -f key=value.`);
		}
		const key = field.slice(0, separator);
		if (query.has(key)) {
			throw new Error(`Parameter "${key}" was given more than once.`);
		}
		query.set(key, field.slice(separator + 1));
	}
	for (const name of [
		"since",
		"start",
		"end",
		"limit",
		"direction",
	] as const) {
		const value = props[name];
		if (value === undefined) continue;
		if (query.has(name)) {
			throw new Error(`Parameter "${name}" was given more than once.`);
		}
		query.set(name, String(value));
	}
	if (props.query !== undefined) {
		if (query.has("query")) {
			throw new Error(
				"Pass LogQL as the positional query or -f query=…, not both.",
			);
		}
		query.set("query", props.query);
	}
	if (props.endpoint === "query_range" && !query.get("query")?.trim()) {
		throw new Error(
			"Pass a LogQL query, e.g. neon logs loki '{entity_type=\"function\"}', or use -f query=…. See neon logs loki --help.",
		);
	}
	return Object.fromEntries(query);
};

export const command = "loki [query]";
export const describe =
	"Call the branch's Loki read API and return its JSON response";

export const builder = (argv: yargs.Argv) =>
	argv
		.usage("$0 logs loki [query] [options]")
		.positional("query", {
			describe: "LogQL expression (or pass -f query=<expression>)",
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
					"Maximum number of log lines; the server enforces its cap",
				type: "number",
				coerce: limit,
			},
			direction: {
				describe:
					"Timestamp order: forward (oldest first) or backward (newest first)",
				type: "string",
				choices: ["forward", "backward"],
				coerce: single("direction"),
			},
			field: {
				alias: "f",
				type: "array",
				string: true,
				nargs: 1,
				describe:
					"String URL parameter key=value (repeatable), including query. Cannot duplicate a positional query or named flag.",
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
			parameters(args as unknown as LokiProps);
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
			"$0 logs loki -f 'query={entity_type=\"storage\"}' -f since=1h -f limit=50",
			"Pass Loki URL parameters as strings, like gh api -f",
		)
		.example(
			"$0 logs loki '{entity_type=\"function\"}' --project-id <id> --branch <id|name> --start 2026-11-01T00:00:00Z --end 2026-11-01T01:00:00Z",
			"Query an explicit branch and absolute time window",
		)
		.epilogue(
			[
				"query_range requires a LogQL query and accepts since, start, end, limit and direction. label/<name>/values accepts time bounds and an optional query containing a stream selector without line filters. Use entity_type, not source, in Loki selectors.",
				"Output: --output json (default) or --output yaml. data.result groups lines by stream labels; each values entry is [timestamp, line], with timestamps kept as nanosecond strings. Preserve warnings: they report truncation, and there is no continuation cursor. Narrow the time window or selector to retrieve complete results.",
				"Neon supports stream selectors and line filters; metric queries, parser stages and live tailing are unsupported. Instant queries are unsupported.",
				"For structured filters, human-readable tables and cursor pagination, use neon logs query --help.",
				"Uses /telemetry/v1 on the origin selected by --api-host or NEON_API_HOST. Availability depends on the project's region and telemetry rollout. See https://neon.com/docs/cli/logs#loki-read-api",
			].join("\n\n"),
		);

export const handler = async (props: LokiProps) => {
	const query = parameters(props);
	const project = pathSegment("project_id", props.projectId);
	const branchId = await branchIdFromProps(props);
	const client = getApiClient({
		apiKey: props.apiKey,
		apiHost: new URL("/telemetry/v1", props.apiHost).toString(),
	});
	const { data } = await client.request({
		method: "GET",
		path: `/projects/${project}/branches/${pathSegment("branch_id", branchId)}/loki/api/v1/${props.endpoint}`,
		query,
	});
	writer({ output: props.output }).end(data, {
		fields: [],
	});
};
