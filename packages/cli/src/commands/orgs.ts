import type {
	Invitation,
	Member,
	MemberRole,
	MemberWithUser,
	Organization,
	SpendingLimitResponse,
} from "@neon/sdk";
import chalk from "chalk";
import type yargs from "yargs";

import { readContextFile } from "../context.js";
import { log } from "../log.js";
import type { CommonProps } from "../types.js";
import { noPassthrough, single } from "../utils/flags.js";
import { writer } from "../writer.js";

const ORG_FIELDS = ["id", "name", "plan"] as const;
const ORG_DETAIL_FIELDS = [
	"id",
	"name",
	"handle",
	"plan",
	"created_at",
] as const;
const MEMBER_TABLE_FIELDS = ["id", "email", "role", "joined_at"] as const;
const MEMBER_FIELDS = ["id", "user_id", "role", "joined_at"] as const;
const INVITATION_FIELDS = ["id", "email", "role", "invited_at"] as const;
const SPENDING_LIMIT_TABLE_FIELDS = ["monthly_limit"] as const;

const MEMBER_ROLES = [
	"admin",
	"member",
	"editor",
	"viewer",
	"collaborator",
] as const satisfies readonly MemberRole[];

const orgIdOption = {
	"org-id": {
		describe:
			"Organization ID. Defaults to the linked organization, or your only one",
		type: "string",
		coerce: single("org-id"),
	},
} as const;

/**
 * An empty, negated, misspelled, or `--`-separated `--org-id` must fail rather than fall
 * back to the linked organization: these commands change members, invitations, and billing.
 */
const guarded = (yargs: yargs.Argv) =>
	yargs.strict().check(noPassthrough("orgs"));

const roleOption = (describe: string) =>
	({
		role: {
			describe,
			type: "string",
			choices: MEMBER_ROLES,
			demandOption: true,
		},
	}) as const;

export const command = "orgs";
export const describe = "Manage organizations";
export const aliases = ["org"];
export const builder = (argv: yargs.Argv) => {
	return argv
		.usage("$0 orgs <sub-command> [options]")
		.command(
			"list",
			"List organizations",
			(yargs) => yargs,
			async (args) => {
				// @ts-expect-error: TODO - Assert `args` is `CommonProps`
				await list(args);
			},
		)
		.command(
			"get [id]",
			"Show an organization",
			(yargs) =>
				yargs
					.positional("id", {
						describe:
							"Organization ID. Defaults to --org-id, the linked organization, or your only one",
						type: "string",
					})
					.options(orgIdOption)
					.strict()
					.check(noPassthrough("orgs")),
			async (args) => await get(args as unknown as GetProps),
		)
		.command("members", "Manage organization members", (yargs) =>
			yargs
				.usage("$0 orgs members <sub-command> [options]")
				.options(orgIdOption)
				.command(
					"list",
					"List members and their organization role",
					guarded,
					async (args) =>
						await listMembers(args as unknown as OrgProps),
				)
				.command(
					"get <member-id>",
					"Show a member",
					(yargs) =>
						guarded(
							yargs.positional("member-id", {
								describe: "Member ID, from `orgs members list`",
								type: "string",
							}),
						),
					async (args) =>
						await getMember(args as unknown as MemberProps),
				)
				.command(
					"update <member-id>",
					"Change a member's organization role. Admin only",
					(yargs) =>
						yargs
							.positional("member-id", {
								describe: "Member ID, from `orgs members list`",
								type: "string",
							})
							.options(roleOption("The new organization role"))
							.strict()
							.check(noPassthrough("orgs")),
					async (args) =>
						await updateMember(
							args as unknown as UpdateMemberProps,
						),
				)
				.command(
					"remove <member-id>",
					"Remove a member from the organization. Admin only",
					(yargs) =>
						guarded(
							yargs.positional("member-id", {
								describe: "Member ID, from `orgs members list`",
								type: "string",
							}),
						),
					async (args) =>
						await removeMember(args as unknown as MemberProps),
				),
		)
		.command("invitations", "Manage organization invitations", (yargs) =>
			yargs
				.usage("$0 orgs invitations <sub-command> [options]")
				.options(orgIdOption)
				.command(
					"list",
					"List invitations",
					guarded,
					async (args) =>
						await listInvitations(args as unknown as OrgProps),
				)
				.command(
					"create",
					"Invite people by email. Each one is emailed, and anyone with a Neon account joins immediately",
					(yargs) =>
						yargs
							.options({
								email: {
									describe:
										"Email address to invite. Repeat to invite several",
									type: "string",
									array: true,
									demandOption: true,
								},
								...roleOption(
									"The organization role every invitee gets",
								),
							})
							.strict()
							.check(noPassthrough("orgs")),
					async (args) =>
						await createInvitations(
							args as unknown as CreateInvitationsProps,
						),
				),
		)
		.command(
			"spending-limit",
			"Manage the organization's monthly spending limit (Launch and Scale plans)",
			(yargs) =>
				yargs
					.usage("$0 orgs spending-limit <sub-command> [options]")
					.options(orgIdOption)
					.command(
						"get",
						"Show the monthly spending limit",
						guarded,
						async (args) =>
							await getSpendingLimit(args as unknown as OrgProps),
					)
					.command(
						"set <usd>",
						"Set the monthly spending limit. Neon emails at 80% and 100% and keeps computes running. Admin only",
						(yargs) =>
							guarded(
								yargs.positional("usd", {
									describe:
										"Monthly limit in US dollars, e.g. 500 or 250.50",
									type: "string",
								}),
							),
						async (args) =>
							await setSpendingLimit(
								args as unknown as SetSpendingLimitProps,
							),
					)
					.command(
						"delete",
						"Remove the monthly spending limit. Admin only",
						guarded,
						async (args) =>
							await deleteSpendingLimit(
								args as unknown as OrgProps,
							),
					),
		);
};
export const handler = (args: yargs.Argv) => {
	return args;
};

type OrgProps = CommonProps & { orgId?: string };
type GetProps = OrgProps & { id?: string };
type MemberProps = OrgProps & { memberId: string };
type UpdateMemberProps = MemberProps & { role: MemberRole };
type CreateInvitationsProps = OrgProps & { email: string[]; role: MemberRole };
type SetSpendingLimitProps = OrgProps & { usd: string };

const list = async (props: CommonProps) => {
	const out = writer(props);

	const {
		data: { organizations },
	} = await props.apiClient.getCurrentUserOrganizations();

	const current = readContextFile(props.contextFile).orgId;
	out.write(organizations, {
		fields: ORG_FIELDS,
		title: "Organizations",
		emptyMessage: "You are not a member of any organization.",
		renderColumns: {
			plan: (org: Organization) => planName(org.plan),
			name: (org: Organization) =>
				org.id === current
					? `${chalk.green("[current]")} ${org.name}`
					: org.name,
		},
	});
	out.end();
};

/** The SDK client, its error mapper, and the org from the flag, `.neon`, or the only one. */
const sdk = async (props: OrgProps) => {
	const [{ fromSdkError, getNeonClient }, { fillSingleOrg }] =
		await Promise.all([
			import("../neon_client.js"),
			import("../utils/enrichers.js"),
		]);
	const { orgId } = await fillSingleOrg({
		...props,
		orgId: props.orgId ?? "",
	});
	return {
		neon: getNeonClient(props),
		orgId,
		fail: (error: unknown) => fromSdkError(error, props.apiHost),
	};
};

const get = async (props: GetProps) => {
	const { neon, fail, orgId } = await sdk({
		...props,
		orgId: props.id ?? props.orgId,
	});
	const org = await neon.organizations
		.get({ orgId })
		.catch((error: unknown) => {
			throw fail(error);
		});
	writer(props).end(org, {
		fields: ORG_DETAIL_FIELDS,
		renderColumns: { plan: (value: Organization) => planName(value.plan) },
	});
};

const listMembers = async (props: OrgProps) => {
	const { neon, fail, orgId } = await sdk(props);
	const members = await neon.organizations.members
		.list({ orgId })
		.all()
		.catch((error: unknown) => {
			throw fail(error);
		});
	const config = {
		title: `Members of ${orgId}`,
		emptyMessage: `No members in ${orgId}.`,
	};
	// JSON and YAML keep the API's `{ member, user }` items; the table needs one flat row.
	if (props.output === "table") {
		writer(props).end(members.map(memberRow), {
			fields: MEMBER_TABLE_FIELDS,
			...config,
		});
		return;
	}
	writer(props).end(members, { fields: [], ...config });
};

const memberRow = ({ member, user }: MemberWithUser) => ({
	id: member.id,
	email: user.email,
	role: member.role,
	joined_at: member.joined_at,
});

const getMember = async (props: MemberProps) => {
	const { neon, fail, orgId } = await sdk(props);
	const member = await neon.organizations.members
		.get({ orgId, memberId: props.memberId })
		.catch((error: unknown) => {
			throw fail(error);
		});
	writeMember(props, member);
};

const updateMember = async (props: UpdateMemberProps) => {
	const { neon, fail, orgId } = await sdk(props);
	const member = await neon.organizations.members
		.update({ orgId, memberId: props.memberId, role: props.role })
		.catch((error: unknown) => {
			throw fail(error);
		});
	writeMember(props, member);
};

const writeMember = (props: OrgProps, member: Member) => {
	writer(props).end(member, { fields: MEMBER_FIELDS });
};

const removeMember = async (props: MemberProps) => {
	const { neon, fail, orgId } = await sdk(props);
	await neon.organizations.members
		.remove({ orgId, memberId: props.memberId })
		.catch((error: unknown) => {
			throw fail(error);
		});
	log.info(`Member ${props.memberId} removed from ${orgId}`);
};

const listInvitations = async (props: OrgProps) => {
	const { neon, fail, orgId } = await sdk(props);
	const invitations = await neon.organizations.invitations
		.list({ orgId })
		.catch((error: unknown) => {
			throw fail(error);
		});
	writeInvitations(props, orgId, invitations);
};

const createInvitations = async (props: CreateInvitationsProps) => {
	const { neon, fail, orgId } = await sdk(props);
	const invitations = await neon.organizations.invitations
		.create({
			orgId,
			invitations: props.email.map((email) => ({
				email,
				role: props.role,
			})),
		})
		.catch((error: unknown) => {
			throw fail(error);
		});
	writeInvitations(props, orgId, invitations);
};

const writeInvitations = (
	props: OrgProps,
	orgId: string,
	invitations: Invitation[],
) => {
	writer(props).end(invitations, {
		fields: INVITATION_FIELDS,
		title: `Invitations to ${orgId}`,
		emptyMessage: `No invitations to ${orgId}.`,
	});
};

const getSpendingLimit = async (props: OrgProps) => {
	const { neon, fail, orgId } = await sdk(props);
	const limit = await neon.organizations.spendingLimit
		.get({ orgId })
		.catch((error: unknown) => {
			throw fail(error);
		});
	writeSpendingLimit(props, orgId, limit);
};

const setSpendingLimit = async (props: SetSpendingLimitProps) => {
	const spendingLimitCents = parseUsdCents(props.usd);
	const { neon, fail, orgId } = await sdk(props);
	const limit = await neon.organizations.spendingLimit
		.set({ orgId, spendingLimitCents })
		.catch((error: unknown) => {
			throw fail(error);
		});
	writeSpendingLimit(props, orgId, limit);
};

const deleteSpendingLimit = async (props: OrgProps) => {
	const { neon, fail, orgId } = await sdk(props);
	await neon.organizations.spendingLimit
		.delete({ orgId })
		.catch((error: unknown) => {
			throw fail(error);
		});
	log.info(`Spending limit removed from ${orgId}`);
};

/** JSON and YAML keep the API's cents; the table shows dollars. */
const writeSpendingLimit = (
	props: OrgProps,
	orgId: string,
	limit: SpendingLimitResponse,
) => {
	if (props.output !== "table") {
		writer(props).end(limit, { fields: [] });
		return;
	}
	const cents = limit.spending_limit_cents;
	writer(props).end(
		{ monthly_limit: cents === null ? "Not set" : formatUsd(cents) },
		{
			fields: SPENDING_LIMIT_TABLE_FIELDS,
			title: `Spending limit for ${orgId}`,
		},
	);
};

const USD = new Intl.NumberFormat("en-US", {
	style: "currency",
	currency: "USD",
});

const formatUsd = (cents: number) => USD.format(cents / 100);

/**
 * `500` or `250.50` → cents. Parsed as text, not with `Number()`: `1e3` and `0x10` are
 * numbers too, and a float multiply turns `0.29` into 28.999… cents.
 */
export const parseUsdCents = (value: unknown): number => {
	const match =
		typeof value === "string"
			? /^(\d+)(?:\.(\d{1,2}))?$/.exec(value.trim())
			: null;
	const cents = match
		? Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"))
		: Number.NaN;
	if (!Number.isSafeInteger(cents) || cents <= 0) {
		throw new Error(
			`spending-limit set needs a positive amount in US dollars, such as 500 or 250.50. Got \`${String(value)}\`. To remove the limit, run \`neon orgs spending-limit delete\`.`,
		);
	}
	return cents;
};

const ACRONYMS: Record<string, string> = { aws: "AWS", pg: "PG" };

/** `free_v3` -> `Free`, `aws_marketplace` -> `AWS Marketplace`; JSON/YAML keep the API id. */
export const planName = (plan: string | undefined): string =>
	(plan ?? "")
		.replace(/_v\d+$/, "")
		.split("_")
		.filter(Boolean)
		.map((word) => ACRONYMS[word] ?? word[0].toUpperCase() + word.slice(1))
		.join(" ");
