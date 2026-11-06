import type { NeonClient, Organization } from "@neon/sdk";
import { getAuthDetails } from "@neon/sdk/raw";
import * as z from "zod";
import {
	bindTool,
	publishedId,
	type ToolClientOptions,
} from "../ergonomic/bind.js";

export const listAccessibleOrganizationsInputSchema = z.strictObject({
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

/**
 * An organization API key sees exactly one organization and cannot call the
 * user endpoints, so the credential type decides which request lists them.
 */
export const accessibleOrganizations = async (
	neon: NeonClient<true>,
	signal?: AbortSignal,
): Promise<Organization[]> => {
	const auth = await getAuthDetails({
		client: neon.client,
		throwOnError: true,
		signal,
	});
	if (auth.auth_method === "api_key_org") {
		return [
			await neon.organizations.get(
				{ orgId: auth.account_id },
				{ signal },
			),
		];
	}
	return neon.user.organizations({ signal });
};

export const listAccessibleOrganizationsTool = (options: ToolClientOptions) =>
	bindTool(
		options,
		{
			operationId: "organizations.listAccessible",
			id: publishedId("organizations.listAccessible"),
			title: "List accessible organizations",
			description:
				"List the organizations the credential can access: every organization of the user for a personal API key or OAuth token, the key's own organization for an organization API key. Supports optional `search` to filter by name or ID.",
			inputSchema: listAccessibleOrganizationsInputSchema,
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: false,
			},
			requiresApproval: false,
			metadata: {
				method: "GET",
				path: "/auth",
				stability: "stable",
				deprecated: false,
				tags: ["Organizations"],
			},
		},
		async (neon, { search }, signal) => {
			const organizations = await accessibleOrganizations(neon, signal);
			if (!search) return organizations;
			return organizations.filter((org) => matchesNameOrId(org, search));
		},
	);
