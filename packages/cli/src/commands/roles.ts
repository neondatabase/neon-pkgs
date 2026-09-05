import type yargs from "yargs";
import { retryOnLock } from "../api.js";
import type { BranchScopeProps } from "../types.js";
import {
	confirmDestructive,
	isMachineOutput,
	yesOption,
} from "../utils/confirm_destructive.js";
import { branchIdFromProps, fillSingleProject } from "../utils/enrichers.js";
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
			(yargs) =>
				yargs.options({
					yes: yesOption,
				}),
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
	props: BranchScopeProps & { role: string; yes: boolean },
) => {
	await confirmDestructive({
		yes: props.yes,
		noun: "role",
		message: `Delete role ${props.role}?`,
		forceYes: isMachineOutput(props.output),
	});
	const branchId = await branchIdFromProps(props);
	const { data } = await retryOnLock(() =>
		props.apiClient.deleteProjectBranchRole(
			props.projectId,
			branchId,
			props.role,
		),
	);
	// A 204 (role already gone) carries no body; only a 200 returns the role.
	if (!data) {
		return;
	}
	if (isMachineOutput(props.output)) {
		writer(props).end(data.role, {
			fields: ROLES_FIELDS,
		});
		return;
	}
	writer(props).text(`Deleted role ${data.role.name}.\n`);
};
