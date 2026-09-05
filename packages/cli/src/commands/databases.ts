import type { Role } from "@neon/sdk";
import type yargs from "yargs";
import { retryOnLock } from "../api.js";

import type { BranchScopeProps } from "../types.js";
import {
	branchIdFromProps,
	fillSingleProject,
	resolveBranchRef,
} from "../utils/enrichers.js";
import { writer } from "../writer.js";

export const DATABASE_FIELDS = ["name", "owner_name", "created_at"] as const;

export const command = "databases";
export const describe = "Manage databases";
export const aliases = ["database", "db"];
export const builder = (argv: yargs.Argv) =>
	argv
		.usage("$0 databases <sub-command> [options]")
		.options({
			"project-id": {
				describe: "Project ID",
				type: "string",
			},
			branch: {
				describe: "Branch ID or name",
				type: "string",
			},
		})
		.middleware(fillSingleProject as any)
		.command(
			"list",
			"List databases",
			(yargs) => yargs,
			(args) => list(args as any),
		)
		.command(
			"create",
			"Create a database",
			(yargs) =>
				yargs.options({
					name: {
						describe: "Database name",
						type: "string",
						demandOption: true,
					},
					"owner-name": {
						describe: "Owner name",
						type: "string",
					},
				}),
			(args) => create(args as any),
		)
		.command(
			"delete <database>",
			"Delete a database",
			(yargs) => yargs,
			(args) => deleteDb(args as any),
		);

export const handler = (args: yargs.Argv) => {
	return args;
};

export const list = async (props: BranchScopeProps) => {
	const branchId = await branchIdFromProps(props);
	const { data } = await props.apiClient.listProjectBranchDatabases(
		props.projectId,
		branchId,
	);
	writer(props).end(data.databases, {
		fields: DATABASE_FIELDS,
	});
};

export const create = async (
	props: BranchScopeProps & {
		name: string;
		ownerName?: string;
	},
) => {
	const branchId = await branchIdFromProps(props);
	const owner =
		props.ownerName ??
		(await props.apiClient
			.listProjectBranchRoles(props.projectId, branchId)
			.then(({ data }) => {
				if (data.roles.length === 0) {
					throw new Error(`No roles found in branch ${branchId}`);
				}
				if (data.roles.length > 1) {
					throw new Error(
						`More than one role found in branch ${branchId}. Please specify the owner name. Roles: ${data.roles
							.map((r: Role) => r.name)
							.join(", ")}`,
					);
				}
				return data.roles[0].name;
			}));
	if (!owner) {
		throw new Error("No owner found");
	}

	const { data } = await retryOnLock(() =>
		props.apiClient.createProjectBranchDatabase(props.projectId, branchId, {
			database: {
				name: props.name,
				owner_name: owner,
			},
		}),
	);

	writer(props).end(data.database, {
		fields: DATABASE_FIELDS,
	});
};

export const deleteDb = async (
	props: BranchScopeProps & { database: string },
) => {
	const { branchId, branchName } = await resolveBranchRef(props);
	const { data, status } = await retryOnLock(() =>
		props.apiClient.deleteProjectBranchDatabase(
			props.projectId,
			branchId,
			props.database,
		),
	);

	// 204 is empty; some clients still parse that as `{}`, so require the record.
	if (status === 200 && data?.database) {
		writer(props).end(data.database, {
			fields: DATABASE_FIELDS,
		});
		return;
	}
	const message = `Database "${props.database}" not found on branch ${branchName}; nothing to delete.`;
	if (props.output === "json" || props.output === "yaml") {
		writer(props).end({ message }, { fields: ["message"] });
		return;
	}
	writer(props).text(`${message}\n`);
};
