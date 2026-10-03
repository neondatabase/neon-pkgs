import type { Organization } from "@neon/sdk";
import chalk from "chalk";
import type yargs from "yargs";

import { readContextFile } from "../context.js";
import type { CommonProps } from "../types.js";
import { writer } from "../writer.js";

const ORG_FIELDS = ["id", "name", "plan"] as const;

export const command = "orgs";
export const describe = "Manage organizations";
export const aliases = ["org"];
export const builder = (argv: yargs.Argv) => {
	return argv.usage("$0 orgs <sub-command> [options]").command(
		"list",
		"List organizations",
		(yargs) => yargs,
		async (args) => {
			// @ts-expect-error: TODO - Assert `args` is `CommonProps`
			await list(args);
		},
	);
};
export const handler = (args: yargs.Argv) => {
	return args;
};

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

const ACRONYMS: Record<string, string> = { aws: "AWS", pg: "PG" };

/** `free_v3` -> `Free`, `aws_marketplace` -> `AWS Marketplace`; JSON/YAML keep the API id. */
export const planName = (plan: string | undefined): string =>
	(plan ?? "")
		.replace(/_v\d+$/, "")
		.split("_")
		.filter(Boolean)
		.map((word) => ACRONYMS[word] ?? word[0].toUpperCase() + word.slice(1))
		.join(" ");
