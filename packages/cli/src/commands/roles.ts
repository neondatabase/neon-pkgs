import type { Role, RoleAccess } from "@neon/sdk";
import type yargs from "yargs";
import { retryOnLock } from "../api.js";
import { log } from "../log.js";
import type { BranchScopeProps } from "../types.js";
import {
	fillSingleProject,
	resolveBranchFromProps,
} from "../utils/enrichers.js";
import { writer } from "../writer.js";

const ROLES_FIELDS = ["name", "created_at"] as const;
// The API generates the password and returns it only here, so the table must show it.
const CREATED_ROLE_FIELDS = ["name", "password", "created_at"] as const;
const ROLE_ACCESS: readonly RoleAccess[] = ["admin", "read_only", "read_write"];

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
			"Create a role. By default it joins neon_superuser (admin on every database); pass --access read_only or read_write for a scoped role",
			(yargs) =>
				yargs
					.options({
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
						access: {
							describe:
								"admin joins neon_superuser. read_only grants SELECT; read_write adds INSERT, UPDATE, DELETE. Scoped roles are created with SQL as the database owner and cover tables that owner owns, now and later",
							type: "string",
							choices: ROLE_ACCESS,
							default: "admin",
						},
						database: {
							describe:
								"Database a read_only or read_write role is scoped to. Defaults to the branch's only database",
							type: "string",
						},
						schema: {
							describe:
								"Schema a read_only or read_write role can use. Repeat for more. Defaults to public",
							type: "string",
							array: true,
						},
					})
					.check((args) => {
						if (
							args.access === "admin" &&
							(args.database !== undefined ||
								args.schema !== undefined)
						) {
							throw new Error(
								"--database and --schema need --access read_only or --access read_write",
							);
						}
						return true;
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
		access: RoleAccess;
		database?: string;
		schema?: string[];
	},
) => {
	// yargs reads bare `--no-login` as `login: false`; `--no-login=<value>` sets `no-login`.
	const noLogin = props["no-login"] === true || props.login === false;
	const { branchId, branch } = await resolveBranchFromProps(props);
	if (props.access === "read_only" || props.access === "read_write") {
		const { fromSdkError, getNeonClient } = await import(
			"../neon_client.js"
		);
		let role: Role;
		try {
			role = await getNeonClient(props).postgres.roles.create(
				{
					projectId: props.projectId,
					branchId,
					name: props.name,
					...(noLogin ? { no_login: true } : {}),
					access: props.access,
					...(props.database === undefined
						? {}
						: { databaseName: props.database }),
					...(props.schema === undefined
						? {}
						: { schemas: props.schema }),
				},
				{ waitForReadiness: true },
			);
		} catch (error) {
			throw fromSdkError(error, props.apiHost);
		}
		writer(props).end(role, {
			fields: CREATED_ROLE_FIELDS,
			humanTitle: `Role created on ${branch?.name ?? branchId}`,
		});
		return;
	}
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
		return;
	}
	log.info(
		`Role "${props.role}" not found on branch ${branch?.name ?? branchId}; nothing to delete.`,
	);
};
