import type yargs from "yargs";

import { isNeonApiError, type NeonApiClient } from "../api.js";
import { log } from "../log.js";
import type { CommonProps } from "../types.js";
import { noPassthrough, single } from "../utils/flags.js";
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
/** Metadata only: the secret is printed separately so it can be copied cleanly. */
const CREATE_TABLE_FIELDS = ["id", "name"] as const;
const CREATE_TABLE_FIELDS_SCOPED = ["id", "name", "project"] as const;
const CREATE_FIELDS_SCOPED = ["id", "name", "project_id", "key"] as const;

/** Rendered for an org key that was not narrowed to a project. Table output only. */
const ALL_PROJECTS = "(all projects)";

/**
 * "This key should carry no project scope."
 *
 * A symbol rather than a string, because project ids are `^[a-z0-9-]{1,60}$` — any sentinel
 * spelled as a string is a legal project id, and a project genuinely called that would have
 * its correctly-scoped key rejected and revoked.
 */
const NO_PROJECT = Symbol("no-project");
type ExpectedScope = string | typeof NO_PROJECT;

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
							coerce: single("org-id"),
						},
					})
					.strict()
					.check(noPassthrough("api-keys")),
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
							coerce: single("name", { required: true }),
						},
						"org-id": {
							describe:
								"Create a key for this organization instead of your account",
							type: "string",
							coerce: single("org-id"),
						},
						"project-id": {
							describe:
								"Create a key that can access only this project. Its organization is looked up from the project",
							type: "string",
							coerce: single("project-id"),
						},
					})
					// A key scoped to a project is already an organization key, so naming
					// both is contradictory rather than redundant — the org is derived from
					// the project and cannot be chosen independently.
					.conflicts("org-id", "project-id")
					.strict()
					.check(noPassthrough("api-keys")),
			async (args) => await create(args as unknown as CreateProps),
		)
		.command(
			"revoke <id>",
			"Revoke an API key. Anything using it stops working immediately",
			(yargs) =>
				yargs
					.positional("id", {
						describe: "The API key id, from `api-keys list`",
						// Deliberately not `type: "number"`. That coerces before `coerce`
						// runs, so an unparseable id arrives as NaN and the error can only
						// echo `NaN` — a JavaScript artifact the user never typed. Taking
						// the raw string lets the message name what they actually passed,
						// and stops NaN reaching the API, which answers "not found" and
						// blames the key rather than the input.
						type: "string",
						demandOption: true,
						coerce: (value: unknown) => {
							// Digits only, checked before Number(): `Number("0x65")` is 101
							// and `Number("1e3")` is 1000, so either would revoke a key the
							// user never named while the message promises "a numeric id".
							const id = Number(value);
							if (
								typeof value !== "string" ||
								!/^\d+$/.test(value.trim()) ||
								!Number.isSafeInteger(id) ||
								id <= 0
							) {
								throw new Error(
									`api-keys revoke needs a numeric key id, from \`neon api-keys list\`. Got \`${String(value)}\`.`,
								);
							}
							return id;
						},
					})
					.options({
						"org-id": {
							describe:
								"Revoke an organization key instead of an account key",
							type: "string",
							coerce: single("org-id"),
						},
					})
					.strict()
					.check(noPassthrough("api-keys")),
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
					title: `API keys in ${props.orgId}`,
					emptyMessage: `No API keys in ${props.orgId}.`,
				},
			);
		} else {
			out.write(data, {
				fields: ORG_FIELDS,
				title: `API keys in ${props.orgId}`,
				emptyMessage: `No API keys in ${props.orgId}.`,
			});
		}
		out.end();
		return;
	}

	const { data } = await props.apiClient.listApiKeys();
	out.write(data, {
		fields: ACCOUNT_FIELDS,
		title: "Account API keys",
		emptyMessage: "You have no account API keys.",
	});
	out.end();
	// Organization keys live on a different endpoint, so a heading of plain "API keys"
	// would claim to be everything while showing only half.
	if (props.output === "table") {
		log.info(
			"Organization keys are listed separately: neon api-keys list --org-id <org> (see `neon orgs list`).",
		);
	}
};

const create = async (props: CreateProps) => {
	const { name, projectId, orgId } = props;

	// Neither flag: an account key, matching `POST /api_keys`. `api-keys` is exempt from
	// `.neon` enrichment (see `isApiKeysCommand`), so reaching this branch means the user
	// really did ask for account scope rather than inheriting a checked-out project.
	if (!projectId && !orgId) {
		const { data } = await props.apiClient.createApiKey({ key_name: name });
		await assertUsable(props, data, { orgId: null, expect: NO_PROJECT });
		report(props, data, CREATE_FIELDS, CREATE_TABLE_FIELDS);
		// The only key here that reaches everything, and the only one that used to say
		// nothing about its reach.
		log.warning(
			"This key reaches everything your account can, in every organization. Pass --org-id or --project-id to narrow it.",
		);
		return;
	}

	if (!projectId && orgId) {
		const { data } = await props.apiClient.createOrgApiKey(orgId, {
			key_name: name,
		});
		await assertUsable(props, data, { orgId, expect: NO_PROJECT });
		report(props, data, CREATE_FIELDS, CREATE_TABLE_FIELDS);
		log.warning(
			"This key reaches every project in %s, including ones created later. Pass --project-id instead to restrict it to one.",
			orgId,
		);
		return;
	}

	const scopeTo = projectId as string;

	// Project-scoped keys exist only on the organization endpoint, so an org is required.
	// Resolve it from the project rather than asking for both: `--project-id` alone would
	// otherwise fail for a reason that isn't visible from the command line.
	const resolvedOrgId = await orgIdForProject(props.apiClient, scopeTo);
	const { data } = await props.apiClient.createOrgApiKey(resolvedOrgId, {
		key_name: name,
		project_id: scopeTo,
	});

	// `project_id` is optional on the response. Printing a key and calling it scoped
	// without checking would hand over a credential whose reach we never confirmed — the
	// one thing this command must not get wrong.
	await assertUsable(props, data, {
		orgId: resolvedOrgId,
		expect: scopeTo,
	});

	report(props, data, CREATE_FIELDS_SCOPED, CREATE_TABLE_FIELDS_SCOPED);
	log.info(
		"Limited to %s: it cannot create projects, mint API keys, or read any other project. It can still change and delete everything inside that project.",
		scopeTo,
	);
};

/**
 * Print the issued key.
 *
 * In a terminal the secret goes on its own line rather than into a table cell: `cli-table`
 * neither wraps nor truncates, so a 50-odd character key makes the row wider than most
 * terminals and the wrapped remainder ends up beside box-drawing characters. Since this is
 * the only time the key is ever shown, it has to be selectable in one gesture. Structured
 * output keeps the key in the object, where a script expects it.
 */
const report = (
	props: CommonProps,
	data: { key?: string; [field: string]: unknown },
	fields: readonly string[],
	tableFields: readonly string[],
) => {
	const out = writer(props);
	if (props.output === "table") {
		// `project` mirrors the column name `list` uses. Added here rather than by the
		// caller so structured output keeps the API's own `project_id` and gains no
		// duplicate under a second name.
		const row =
			typeof data.project_id === "string"
				? { ...data, project: data.project_id }
				: data;
		out.write(row as never, {
			fields: tableFields as never,
			title: "API key",
		});
		out.end();
		// Blank line so the key is visually detached from the table border, and so
		// `| tail -1` on stdout yields exactly the key (both notices go to stderr).
		out.text(`\n${data.key}\n`);
	} else {
		out.write(data as never, { fields: fields as never, title: "API key" });
		out.end();
	}
	log.warning("Store this key now: it is not shown again.");
};

/**
 * Refuse to report a key that isn't what we asked for, and take it back.
 *
 * Two ways a 2xx can still be wrong: no `key` in the body, which leaves a live credential
 * the user can never see or use; and a `project_id` that doesn't match the requested
 * project, which would mean announcing a scope the key does not have. Both withdraw the key
 * before throwing.
 *
 * The thrown message states whether the withdrawal actually succeeded. Saying "the key has
 * been revoked" when the revoke itself failed would be worse than saying nothing — it would
 * leave an unverified credential live while telling the user it is gone.
 */
const assertUsable = async (
	props: CommonProps,
	data: { id?: number; key?: string; project_id?: string },
	scope: { orgId: string | null; expect: ExpectedScope },
): Promise<void> => {
	// `expect` is always stated, never inferred from a missing field: "no project" has to be
	// checked as deliberately as an exact project, or a key that came back narrower than
	// requested would be reported as reaching the whole organization.
	const wanted = scope.expect === NO_PROJECT ? undefined : scope.expect;
	const problem =
		typeof data.key !== "string" || data.key.trim() === ""
			? "Neon returned no key."
			: data.project_id !== wanted
				? `Neon returned a key scoped to ${data.project_id ?? "nothing"} rather than ${wanted ?? "the whole organization"}.`
				: null;
	if (!problem) return;

	const withdrawn = await withdraw(props, scope.orgId, data.id);
	throw new Error(
		`${problem} ${
			withdrawn
				? "The key has been revoked; nothing was issued."
				: `The key could NOT be revoked and may still be live${
						data.id === undefined
							? ""
							: `. Remove it with \`neon api-keys revoke ${data.id}${
									scope.orgId
										? ` --org-id ${scope.orgId}`
										: ""
								}\``
					}.`
		}`,
	);
};

/**
 * Revoke, turning the most likely mistake into a usable message.
 *
 * Account and organization keys live on different endpoints, and `api-keys list --org-id X`
 * shows ids that the account endpoint cannot see. Copying one and forgetting the flag — or
 * leaving it on for an account key — is the easy error, and a bare "API key not found" sends
 * the user looking for a deleted key rather than a misplaced flag.
 *
 * Only the key id is worth second-guessing here: an org id that is wrong or not yours does
 * not reach this path at all, because the API answers "not an organization member" (verified
 * against production) rather than a 404.
 */
const revokeOrExplain = async (props: RevokeProps) => {
	try {
		return props.orgId
			? await props.apiClient.revokeOrgApiKey(props.orgId, props.id)
			: await props.apiClient.revokeApiKey(props.id);
	} catch (err) {
		if (isNeonApiError(err) && err.status === 404) {
			throw new Error(
				props.orgId
					? `No API key with id ${props.id} in ${props.orgId}. If it is one of your account's own keys, drop --org-id.`
					: `No account API key with id ${props.id}. If it belongs to an organization, pass --org-id. Organization keys are not visible to your account.`,
			);
		}
		throw err;
	}
};

/** Best-effort withdrawal of a key we are refusing to report. Never throws. */
const withdraw = async (
	props: CommonProps,
	orgId: string | null,
	keyId: number | undefined,
): Promise<boolean> => {
	if (!Number.isSafeInteger(keyId) || (keyId as number) <= 0) return false;
	try {
		const { data } = orgId
			? await props.apiClient.revokeOrgApiKey(orgId, keyId as number)
			: await props.apiClient.revokeApiKey(keyId as number);
		// Check which key the response names: a `revoked: true` for some other id is not
		// evidence that the one we issued is gone.
		return data.revoked === true && data.id === keyId;
	} catch (err) {
		log.error(
			"Failed to revoke API key %d: %s",
			keyId,
			err instanceof Error ? err.message : String(err),
		);
		return false;
	}
};

const revoke = async (props: RevokeProps) => {
	const out = writer(props);
	const { data } = await revokeOrExplain(props);
	out.write(data, {
		fields: ["id", "name", "revoked", "last_used_at"],
		title: "API key",
	});
	out.end();
};

/**
 * The organization a project belongs to. A project outside any organization cannot have a
 * scoped key — the endpoint that accepts `project_id` is org-only — so that case fails here
 * with the reason, rather than as a 404 from a URL the user never typed.
 */
export const orgIdForProject = async (
	client: NeonApiClient,
	projectId: string,
): Promise<string> => {
	let orgId: string | undefined;
	try {
		const {
			data: { project },
		} = await client.getProject(projectId);
		orgId = project.org_id;
	} catch (err) {
		if (isNeonApiError(err) && err.status === 404) {
			throw new Error(
				projectId.startsWith("org-")
					? `Project ${projectId} not found. That looks like an organization id. Pass it as --org-id instead.`
					: `Project ${projectId} not found. Check the id with \`neon projects list\`.`,
			);
		}
		throw err;
	}
	if (!orgId) {
		throw new Error(
			`Project ${projectId} does not belong to an organization, so it cannot have a project-scoped API key. Omit --project-id to create an account key.`,
		);
	}
	return orgId;
};
