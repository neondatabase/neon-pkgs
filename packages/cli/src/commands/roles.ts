import type yargs from "yargs";
import { retryOnLock } from "../api.js";
import type { BranchScopeProps } from "../types.js";
import {
	fillSingleProject,
	resolveBranchFromProps,
} from "../utils/enrichers.js";
import { writer } from "../writer.js";

const ROLES_FIELDS = ["name", "created_at"] as const;
// The API generates the password and returns it only here, so the table must show it.
const CREATED_ROLE_FIELDS = ["name", "password", "created_at"] as const;

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
	const { branchId, branch } = await resolveBranchFromProps(props);
	const { data } = await props.apiClient.listProjectBranchRoles(
		props.projectId,
		branchId,
	);
	const branchLabel = branch?.name ?? branchId;
	writer(props).end(data.roles, {
		fields: ROLES_FIELDS,
		humanTitle: `Roles on ${branchLabel}`,
		emptyMessage: `No roles on ${branchLabel}.`,
	});
};

export const create = async (
	props: BranchScopeProps & {
		name: string;
		"no-login"?: boolean;
		login?: boolean;
	},
) => {
	// yargs reads bare `--no-login` as `login: false`; `--no-login=<value>` sets `no-login`.
	const noLogin = props["no-login"] === true || props.login === false;
	const { branchId, branch } = await resolveBranchFromProps(props);
	const { data } = await retryOnLock(() =>
		props.apiClient.createProjectBranchRole(props.projectId, branchId, {
			role: {
				name: props.name,
				...(noLogin ? { no_login: true } : {}),
			},
		}),
	);
	writer(props).end(data.role, {
		fields: CREATED_ROLE_FIELDS,
		humanTitle: `Role created on ${branch?.name ?? branchId}`,
	});
};

export const deleteRole = async (
	props: BranchScopeProps & { role: string },
) => {
	const { branchId, branch } = await resolveBranchFromProps(props);
	const { data } = await retryOnLock(() =>
		props.apiClient.deleteProjectBranchRole(
			props.projectId,
			branchId,
			props.role,
		),
	);
	// A 204 (role already gone) carries no body; only a 200 returns the role.
	if (data) {
		writer(props).end(data.role, {
			fields: ROLES_FIELDS,
			humanTitle: `Role deleted from ${branch?.name ?? branchId}`,
		});
	}
};
