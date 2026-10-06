import type yargs from "yargs";
import type { ProjectScopeProps } from "../types.js";
import { fillSingleProject } from "../utils/enrichers.js";
import { writer } from "../writer.js";

const OPERATIONS_FIELDS = ["id", "action", "status", "created_at"] as const;

const OPERATIONS_TABLE_FIELDS = [
	"action",
	"status",
	"branch_id",
	"duration",
	"created_at",
	"id",
] as const;

export const command = "operations";
export const describe = "Manage operations";
export const aliases = ["operation"];
export const builder = (argv: yargs.Argv) =>
	argv
		.usage("$0 operations <sub-command> [options]")
		.options({
			"project-id": {
				describe: "Project ID",
				type: "string",
			},
		})
		.middleware(fillSingleProject as any)
		.command(
			"list",
			"List operations",
			(yargs) => yargs,
			(args) => list(args as any),
		);

export const handler = (args: yargs.Argv) => {
	return args;
};

export const list = async (props: ProjectScopeProps & { limit: number }) => {
	const { data } = await props.apiClient.listProjectOperations({
		projectId: props.projectId,
		limit: props.limit,
	});
	if (props.output === "json" || props.output === "yaml") {
		writer(props).end(data.operations, {
			fields: OPERATIONS_FIELDS,
		});
		return;
	}
	writer(props).end(
		data.operations.map((op) => ({
			action: op.action,
			status: op.status,
			branch_id: op.branch_id ?? "-",
			duration: `${op.total_duration_ms} ms`,
			created_at: op.created_at,
			id: op.id,
		})),
		{
			fields: OPERATIONS_TABLE_FIELDS,
			emptyMessage: "No operations found in this project.",
		},
	);
};
