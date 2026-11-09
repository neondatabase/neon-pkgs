import * as z from "zod";
import {
	bindTool,
	publishedId,
	type ToolClientOptions,
} from "../ergonomic/bind.js";

export const userOrganizationsInputSchema = z.strictObject({
	search: z
		.string()
		.describe("Part of an organization name or id, ignoring case.")
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
			title: "List organizations for the current user",
			description:
				"Lists the organizations the user belongs to; an organization API key gets its own organization. search filters by name or id.",
			inputSchema: userOrganizationsInputSchema,
			annotations: { readOnlyHint: true, openWorldHint: false },
			requiresApproval: false,
			metadata: {
				method: "GET",
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
