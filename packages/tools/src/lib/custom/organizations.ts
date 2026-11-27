import * as z from "zod";
import * as output from "../../generated/output.gen.js";
import {
	bindTool,
	publishedId,
	type ToolClientOptions,
} from "../ergonomic/bind.js";

export const userOrganizationsInputSchema = z.strictObject({
	search: z
		.string()
		.describe("Org name/id substring, ignoring case.")
		.optional(),
});

export const matchesNameOrId = (
	entity: { name: string; id: string },
	query: string,
) => {
	const needle = query.toLowerCase();
	return (
		entity.name.toLowerCase().includes(needle) ||
		entity.id.toLowerCase().includes(needle)
	);
};

export const userOrganizationsTool = (options: ToolClientOptions) =>
	bindTool(
		options,
		{
			operationId: "user.organizations",
			id: publishedId("user.organizations"),
			title: "List user organizations",
			description:
				"Lists user orgs, or the key's org; search matches name or id.",
			inputSchema: userOrganizationsInputSchema,
			outputSchema: z.array(output.Organization),
			annotations: { readOnlyHint: true, openWorldHint: false },
			requiresApproval: false,
			metadata: {
				method: "GET",
				readOnlySafe: true,
				path: "/users/me/organizations",
				stability: "stable",
				deprecated: false,
				tags: ["Users", "Organizations"],
			},
		},
		async (neon, { search }, signal) => {
			const organizations = await neon.user.organizations({ signal });
			if (!search) return organizations;
			return organizations.filter((org) => matchesNameOrId(org, search));
		},
	);
