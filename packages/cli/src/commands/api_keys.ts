import type yargs from "yargs";

import { isNeonApiError } from "../api.js";
import { log } from "../log.js";
import type { CommonProps } from "../types.js";
import { writer } from "../writer.js";

const ACCOUNT_FIELDS = [
	"id",
	"name",
	"created_at",
	"last_used_at",
	"last_used_from_addr",
] as const;

/**
 * Table view of an org listing. `project` is the rendered column; the raw `project_id` is
 * what structured output keeps. See {@link list} for why the two differ.
 */
const ORG_TABLE_FIELDS = [
	"id",
	"name",
	"project",
	"created_at",
	"last_used_at",
	"last_used_from_addr",
] as const;

const ORG_FIELDS = [
	"id",
	"name",
	"project_id",
	"created_at",
	"last_used_at",
	"last_used_from_addr",
] as const;

const CREATE_FIELDS = ["id", "name", "key"] as const;
const CREATE_FIELDS_SCOPED = ["id", "name", "project_id", "key"] as const;

/** Rendered for an org key that was not narrowed to a project. Table output only. */
const ALL_PROJECTS = "— all projects —";

/**
 * Reject a flag that was passed with an empty value.
 *
 * `--project-id "$PROJECT"` with `PROJECT` unset arrives as an empty string, which is falsy
 * — so without this, asking for a project-scoped key would quietly mint an **account** key
 * instead, and `revoke --org-id ""` would delete from the wrong key class. Silently
 * widening a credential because a shell variable was empty is the worst failure this
 * command could have, so it is an error rather than a fallback.
 */
const rejectEmptyValues =
	(...names: string[]) =>
	(argv: Record<string, unknown>): true => {
		for (const name of names) {
			const value = argv[name];
			if (typeof value === "string" && value.trim() === "") {
				throw new Error(
					`--${name} was given an empty value. Pass a real value, or omit the flag entirely.`,
				);
			}
		}
		return true;
	};

export const command = "api-keys";
export const aliases = ["api-key"];
export const describe = "Manage API keys";

export const builder = (argv: yargs.Argv) =>
	argv
		.usage("$0 api-keys <sub-command> [options]")
		.command(
			"list",
			"List API keys for your account, or for an organization",
			(yargs) =>
				yargs
					.options({
						"org-id": {
							describe:
								"List the organization's keys instead of your account's",
							type: "string",
						},
					})
					.check(rejectEmptyValues("org-id")),
			async (args) => await list(args as unknown as ListProps),
		)
		.command(
			"create",
			"Create an API key. The key is shown once and cannot be retrieved again",
			(yargs) =>
				yargs
					.options({
						name: {
							describe: "A name to identify the key later",
							type: "string",
							demandOption: true,
						},
						"org-id": {
							describe:
								"Create a key for this organization instead of your account",
							type: "string",
						},
						"project-id": {
							describe:
								"Create a key that can access only this project. Its organization is looked up from the project",
							type: "string",
						},
					})
					// A key scoped to a project is already an organization key, so naming
					// both is contradictory rather than redundant — the org is derived from
					// the project and cannot be chosen independently.
					.conflicts("org-id", "project-id")
					.check(rejectEmptyValues("name", "org-id", "project-id")),
			async (args) => await create(args as unknown as CreateProps),
		)
		.command(
			"revoke <id>",
			"Revoke an API key. Anything using it stops working immediately",
			(yargs) =>
				yargs
					.positional("id", {
						describe: "The API key id, from `api-keys list`",
						type: "number",
						demandOption: true,
					})
					.options({
						"org-id": {
							describe:
								"Revoke an organization key instead of an account key",
							type: "string",
						},
					})
					.check(rejectEmptyValues("org-id")),
			async (args) => await revoke(args as unknown as RevokeProps),
		)
		.demandCommand(1, "Run `neon api-keys --help` to see the subcommands.");

export const handler = (args: yargs.Argv) => args;

type ListProps = CommonProps & { orgId?: string };
type CreateProps = CommonProps & {
	name: string;
	orgId?: string;
	projectId?: string;
};
type RevokeProps = CommonProps & { id: number; orgId?: string };

const list = async (props: ListProps) => {
	const out = writer(props);

	if (props.orgId) {
		const { data } = await props.apiClient.listOrgApiKeys(props.orgId);

		// `writeTable` drops any column empty in every row, so an all-absent `project_id`
		// would take the whole column with it — hiding the answer exactly when it is "none
		// of them are scoped". Fill it in for the table, but leave structured output alone:
		// json/yaml serialize the whole object, so a synthetic field there would change the
		// machine-readable shape and duplicate `project_id` under a second name.
		if (props.output === "table") {
			out.write(
				data.map((key) => ({
					...key,
					project: key.project_id ?? ALL_PROJECTS,
				})),
				{
					fields: ORG_TABLE_FIELDS,
					title: "API keys",
					emptyMessage: "This organization has no API keys.",
				},
			);
		} else {
			out.write(data, {
				fields: ORG_FIELDS,
				title: "API keys",
				emptyMessage: "This organization has no API keys.",
			});
		}
		out.end();
		return;
	}

	const { data } = await props.apiClient.listApiKeys();
	out.write(data, {
		fields: ACCOUNT_FIELDS,
		title: "API keys",
		emptyMessage: "You have no API keys.",
	});
	out.end();
};

const create = async (props: CreateProps) => {
	const { name, projectId, orgId } = props;
	const out = writer(props);

	// Neither flag: an account key, matching `POST /api_keys`. `api-keys` is exempt from
	// `.neon` enrichment (see `isApiKeysCommand`), so reaching this branch means the user
	// really did ask for account scope rather than inheriting a checked-out project.
	if (!projectId && !orgId) {
		const { data } = await props.apiClient.createApiKey({ key_name: name });
		out.write(data, { fields: CREATE_FIELDS, title: "API key" });
		out.end();
		warnStoreItNow();
		return;
	}

	if (!projectId && orgId) {
		const { data } = await props.apiClient.createOrgApiKey(orgId, {
			key_name: name,
		});
		out.write(data, { fields: CREATE_FIELDS, title: "API key" });
		out.end();
		warnStoreItNow();
		log.info(
			"Reaches every project in %s. Pass --project-id instead to restrict it to one.",
			orgId,
		);
		return;
	}

	const scopeTo = projectId as string;

	// Project-scoped keys exist only on the organization endpoint, so an org is required.
	// Resolve it from the project rather than asking for both: `--project-id` alone would
	// otherwise fail for a reason that isn't visible from the command line.
	const resolvedOrgId = await orgIdForProject(props, scopeTo);
	const { data } = await props.apiClient.createOrgApiKey(resolvedOrgId, {
		key_name: name,
		project_id: scopeTo,
	});

	// `project_id` is optional on the response. Printing a key and calling it scoped
	// without checking would hand the user a credential whose reach we have not confirmed
	// — the one thing this command must never get wrong. Revoke and fail instead.
	if (data.project_id !== scopeTo) {
		await revokeUnverified(props, resolvedOrgId, data.id);
		throw new Error(
			`Neon returned a key scoped to ${data.project_id ?? "nothing"} rather than ${scopeTo}. The key has been revoked; nothing was issued.`,
		);
	}

	out.write(data, { fields: CREATE_FIELDS_SCOPED, title: "API key" });
	out.end();
	warnStoreItNow();
	log.info(
		"Limited to %s: it cannot create projects, mint API keys, or read any other project. It can still change and delete everything inside that project.",
		scopeTo,
	);
};

const revoke = async (props: RevokeProps) => {
	const out = writer(props);
	const { data } = props.orgId
		? await props.apiClient.revokeOrgApiKey(props.orgId, props.id)
		: await props.apiClient.revokeApiKey(props.id);
	out.write(data, {
		fields: ["id", "name", "revoked", "last_used_at"],
		title: "API key",
	});
	out.end();
};

/**
 * Withdraw a key we are about to refuse to report. Best-effort: if the revoke also fails the
 * caller still throws, but the user is told the key exists so they can remove it by hand
 * rather than being left with a live credential they never saw.
 */
const revokeUnverified = async (
	props: CommonProps,
	orgId: string,
	keyId: number,
): Promise<void> => {
	try {
		await props.apiClient.revokeOrgApiKey(orgId, keyId);
	} catch (err) {
		log.error(
			"Could not revoke API key %d after it failed verification. Revoke it manually with `neon api-keys revoke %d --org-id %s`. Cause: %s",
			keyId,
			keyId,
			orgId,
			err instanceof Error ? err.message : String(err),
		);
	}
};

/**
 * The organization a project belongs to. A project outside any organization cannot have a
 * scoped key — the endpoint that accepts `project_id` is org-only — so that case fails here
 * with the reason, rather than as a 404 from a URL the user never typed.
 */
const orgIdForProject = async (
	props: CommonProps,
	projectId: string,
): Promise<string> => {
	let orgId: string | undefined;
	try {
		const {
			data: { project },
		} = await props.apiClient.getProject(projectId);
		orgId = project.org_id;
	} catch (err) {
		if (isNeonApiError(err) && err.status === 404) {
			throw new Error(
				`Project ${projectId} not found. Check the id with \`neon projects list\`.`,
			);
		}
		throw err;
	}
	if (!orgId) {
		throw new Error(
			`Project ${projectId} does not belong to an organization, so it cannot have a project-scoped API key. Create an account key by omitting --project-id.`,
		);
	}
	return orgId;
};

const warnStoreItNow = () =>
	log.info("Store this key now — it is not shown again.");
