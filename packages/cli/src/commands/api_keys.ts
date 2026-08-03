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
 * "This key should carry no project scope."
 *
 * A symbol rather than a string, because project ids are `^[a-z0-9-]{1,60}$` — any sentinel
 * spelled as a string is a legal project id, and a project genuinely called that would have
 * its correctly-scoped key rejected and revoked.
 */
const NO_PROJECT = Symbol("no-project");
type ExpectedScope = string | typeof NO_PROJECT;

/**
 * Reject a scope flag that is present but unusable.
 *
 * Every failure mode here ends the same way — the flag reads as absent, the scope check
 * falls through, and an **account** key is minted instead of the narrow one asked for.
 * Widening a credential because of a shell accident is the worst thing this command could
 * do, so each case is an error rather than a fallback:
 *
 * - `--project-id "$PROJECT"` with `PROJECT` unset arrives as an empty string, which is falsy.
 * - The same flag passed twice arrives as an array, which is not a string and would reach
 *   the API as `a,b`.
 *
 * A *misspelled* flag is the third case and cannot be caught here, because yargs never binds
 * it — `.strictOptions()` on each subcommand rejects it instead.
 */
/**
 * A scope flag is either absent, or exactly one non-empty string. Anything else is an error.
 *
 * Every rejected shape otherwise ends the same way: the flag reads as falsy, the scope check
 * falls through, and an **account** key is minted instead of the narrow one asked for. That
 * is the worst thing this command can do, so none of them get a lenient reading.
 *
 * - `--project-id ""` — an unset shell variable; empty string, which is falsy.
 * - `--no-project-id` — yargs boolean negation; `false`, which is falsy.
 * - `--project-id a --project-id b` — an array, which would reach the API as `a,b`.
 *
 * A misspelled flag never binds at all and cannot be seen here; `.strict()` rejects it.
 * Anything after a `--` terminator is handled by {@link noPassthrough}.
 */
const single = (name: string) => (value: unknown) => {
	if (value === undefined) return undefined;
	if (Array.isArray(value)) {
		throw new Error(
			`--${name} was given more than once. Pass it at most once.`,
		);
	}
	if (typeof value !== "string" || value.trim() === "") {
		throw new Error(
			`--${name} needs a value. Pass one, or omit the flag entirely.`,
		);
	}
	return value;
};

/**
 * Refuse arguments after a `--` terminator.
 *
 * The CLI sets `populate--`, so everything past `--` lands in `argv["--"]` where `.strict()`
 * never looks — `create --name x -- --project-id p` would parse cleanly and mint an account
 * key from a line that names the scope flag. No `api-keys` subcommand takes passthrough
 * arguments, so their presence is always a mistake.
 */
const noPassthrough = (argv: Record<string, unknown>): true => {
	const rest = argv["--"];
	if (Array.isArray(rest) && rest.length > 0) {
		throw new Error(
			`api-keys takes no arguments after \`--\`, and options placed there are ignored rather than applied. Remove the \`--\`.`,
		);
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
							coerce: single("org-id"),
						},
					})
					.strict()
					.check(noPassthrough),
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
							coerce: single("name"),
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
					.check(noPassthrough),
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
							coerce: single("org-id"),
						},
					})
					.strict()
					.check(noPassthrough),
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

	// Neither flag: an account key, matching `POST /api_keys`. `api-keys` is exempt from
	// `.neon` enrichment (see `isApiKeysCommand`), so reaching this branch means the user
	// really did ask for account scope rather than inheriting a checked-out project.
	if (!projectId && !orgId) {
		const { data } = await props.apiClient.createApiKey({ key_name: name });
		await assertUsable(props, data, { orgId: null, expect: NO_PROJECT });
		report(props, data, CREATE_FIELDS);
		return;
	}

	if (!projectId && orgId) {
		const { data } = await props.apiClient.createOrgApiKey(orgId, {
			key_name: name,
		});
		await assertUsable(props, data, { orgId, expect: NO_PROJECT });
		report(props, data, CREATE_FIELDS);
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
	// without checking would hand over a credential whose reach we never confirmed — the
	// one thing this command must not get wrong.
	await assertUsable(props, data, {
		orgId: resolvedOrgId,
		expect: scopeTo,
	});

	report(props, data, CREATE_FIELDS_SCOPED);
	log.info(
		"Limited to %s: it cannot create projects, mint API keys, or read any other project. It can still change and delete everything inside that project.",
		scopeTo,
	);
};

/** Print the issued key and the reminder that it will not be shown again. */
const report = (
	props: CommonProps,
	data: unknown,
	fields: readonly string[],
) => {
	const out = writer(props);
	out.write(data as never, { fields: fields as never, title: "API key" });
	out.end();
	log.info("Store this key now — it is not shown again.");
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
							: ` — remove it with \`neon api-keys revoke ${data.id}${
									scope.orgId
										? ` --org-id ${scope.orgId}`
										: ""
								}\``
					}.`
		}`,
	);
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
