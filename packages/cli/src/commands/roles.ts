import type yargs from "yargs";
import { retryOnLock } from "../api.js";
import type { BranchScopeProps } from "../types.js";
import {
	branchIdFromProps,
	fillSingleProject,
	resolveBranchRef,
} from "../utils/enrichers.js";
import { writer } from "../writer.js";

const ROLES_FIELDS = ["name", "created_at"] as const;

export const command = "roles";
export const describe = "Manage roles";
export const aliases = ["role"];
export const builder = (argv: yargs.Argv) =>
	argv
		.usage("$0 roles <sub-command> [options]")
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
			"List roles",
			(yargs) => yargs,
			(args) => list(args as any),
		)
		.command(
			"create",
			"Create a role",
			(yargs) =>
				yargs.options({
					name: {
						describe: "Role name",
						type: "string",
						demandOption: true,
					},
					"no-login": {
						describe:
							"Create a passwordless role that cannot login",
						boolean: true,
					},
				}),
			(args) => create(args as any),
		)
		.command(
			"delete <role>",
			"Delete a role",
			(yargs) => yargs,
			(args) => deleteRole(args as any),
		);

export const handler = (args: yargs.Argv) => {
	return args;
};

export const list = async (props: BranchScopeProps) => {
	const branchId = await branchIdFromProps(props);
	const { data } = await props.apiClient.listProjectBranchRoles(
		props.projectId,
		branchId,
	);
	writer(props).end(data.roles, {
		fields: ROLES_FIELDS,
	});
};

export const create = async (
	props: BranchScopeProps & {
		name: string;
		"no-login": boolean;
	},
) => {
	const branchId = await branchIdFromProps(props);
	const { data } = await retryOnLock(() =>
		props.apiClient.createProjectBranchRole(props.projectId, branchId, {
			role: {
				name: props.name,
				no_login: props["no-login"],
			},
		}),
	);
	writer(props).end(data.role, {
		fields: ROLES_FIELDS,
	});
};

export const deleteRole = async (
	props: BranchScopeProps & { role: string },
) => {
	const { branchId, branchName } = await resolveBranchRef(props);
	const { data, status } = await retryOnLock(() =>
		props.apiClient.deleteProjectBranchRole(
			props.projectId,
			branchId,
			props.role,
		),
	);
	// 204 is empty; some clients still parse that as `{}`, so require the record.
	if (status === 200 && data?.role) {
		writer(props).end(data.role, {
			fields: ROLES_FIELDS,
		});
		return;
	}
	const message = `Role "${props.role}" not found on branch ${branchName}; nothing to delete.`;
	if (props.output === "json" || props.output === "yaml") {
		writer(props).end({ message }, { fields: ["message"] });
	} else {
		writer(props).text(`${message}\n`);
	}
	// throw would log ERROR to stderr and leave stdout empty, so JSON would still look like a silent success
	process.exitCode = 1;
};
