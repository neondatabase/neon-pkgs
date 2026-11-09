import * as z from "zod";
import {
	bindTool,
	publishedId,
	type ToolClientOptions,
} from "../ergonomic/bind.js";

export const userOrganizationsInputSchema = z.strictObject({
	search: z
		.string()
		.describe(
			"Search organizations by name or ID. You can specify partial name or ID values to filter results.",
		)
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
				"Retrieves the organizations that the currently authenticated user belongs to. An organization API key returns its own organization. Pass `search` to filter by name or ID.",
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
