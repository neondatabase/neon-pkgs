import type yargs from "yargs";
import { getApiClient, pathSegment } from "../api.js";
import type { BranchScopeProps } from "../types.js";
import { branchIdFromProps, fillSingleProject } from "../utils/enrichers.js";
import { noPassthrough, single } from "../utils/flags.js";
import { writer } from "../writer.js";

type LokiProps = BranchScopeProps & {
	query?: string;
	field?: string[];
	endpoint: string;
};

const endpoint = (value: unknown): string => {
	const path = single("endpoint")(value);
	if (
		path === undefined ||
		!(
			/^(query_range|query|labels)$/.test(path) ||
			/^label\/[a-zA-Z_][a-zA-Z0-9_]*\/values$/.test(path)
		)
	) {
		throw new Error(
			"--endpoint must be query_range, query, labels, or label/<name>/values.",
		);
	}
	return path;
};

const parameters = (props: Pick<LokiProps, "query" | "field" | "endpoint">) => {
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
	if (props.query !== undefined) {
		if (query.has("query")) {
			throw new Error(
				"Pass LogQL as the positional query or -f query=…, not both.",
			);
		}
		query.set("query", props.query);
	}
	if (
		(props.endpoint === "query_range" || props.endpoint === "query") &&
		!query.get("query")?.trim()
	) {
		throw new Error(
			"Pass a LogQL query, e.g. neon loki '{service_name=\"api\"}', or use -f query=….",
		);
	}
	return Object.fromEntries(query);
};

export const command = "loki [query]";
export const describe =
	"Query the branch's Loki API (authenticated passthrough)";

export const builder = (argv: yargs.Argv) =>
	argv
		.usage("$0 loki [query] [options]")
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
			field: {
				alias: "f",
				type: "array",
				string: true,
				nargs: 1,
				describe:
					"Loki query parameter key=value (repeatable, kept as strings). Parameters: query, start, end, since, limit, direction (forward|backward).",
			},
			endpoint: {
				describe:
					"Loki endpoint: query_range, labels, label/<name>/values, or query (instant queries are currently unsupported by Neon).",
				type: "string",
				default: "query_range",
				coerce: endpoint,
			},
		})
		.check(noPassthrough("loki"))
		.check((args) => {
			parameters(args as unknown as LokiProps);
			return true;
		})
		.middleware(fillSingleProject as any)
		.strict()
		.example(
			'$0 loki \'{service_name="neon-function/api"} |= "error"\' -f since=30m',
			"Query the last 30 minutes of function logs",
		)
		.example("$0 loki --endpoint labels", "List stream labels")
		.example(
			"$0 loki --endpoint label/service_name/values -f since=6h",
			"List service names",
		)
		.epilogue(
			"Uses /telemetry/v1 on the origin selected by --api-host or NEON_API_HOST. Returns the complete Loki envelope as JSON by default, or --output yaml. Neon supports stream selectors and line filters; metric queries, parser stages and live tailing are unsupported. Availability depends on the project's region and telemetry rollout.",
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
	writer({ output: props.output === "yaml" ? "yaml" : "json" }).end(data, {
		fields: [],
	});
};
