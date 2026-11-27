import type * as z from "zod";
import { toolDescriptions } from "../../descriptions.gen.js";
import {
	bindTool,
	publishedId,
	type ToolClientOptions,
} from "../ergonomic/bind.js";
import {
	setSpendCapInput,
	spendCapApi,
	spendCapInput,
	spendCapResponse,
} from "./spend-cap-api.js";

const notices = [
	"For new limits, omitted spend_cap_enabled defaults to suspension when spending limits are available for the organization. For existing limits, omission preserves saved enforcement, including notifications-only limits. Explicit false creates notifications only and does not require observed usage; a new enabled limit requires observed current-invoice usage.",
	"Usage detection can lag by 1-2 hours; this is not a guaranteed maximum bill. Storage charges continue during suspension.",
	"Billing resets on the first UTC calendar day of each month. Only the current open invoice counts, including when plan changes create multiple invoices in one month.",
	"Missing status fields are unavailable or unsupported; they do not prove enforcement is off or applied.",
	"Enforcement converges asynchronously. Applied means control planes acknowledged the decision, not that all workloads finished stopping or resuming. Other restrictions can remain.",
];

const result = (data: z.infer<typeof spendCapResponse>, updated = false) => ({
	...data,
	notice: (updated
		? [
				"Configuration accepted; check enforcement_status for pending restriction or recovery acknowledgement.",
				...notices,
			]
		: [...notices]
	).join("\n"),
});

const metadata = {
	method: "GET",
	path: "/organizations/{org_id}/billing/spending_limit",
	stability: "beta",
	deprecated: false,
	tags: ["Organizations"],
	readOnlySafe: true,
};

const annotations = {
	readOnlyHint: false,
	destructiveHint: true,
	idempotentHint: true,
	openWorldHint: true,
};

export const getSpendCapTool = (options: ToolClientOptions) =>
	bindTool(
		options,
		{
			operationId: "organizations.spendingLimit.get",
			id: publishedId("organizations.spendingLimit.get"),
			title: "Get spending limit",
			description: "Gets spending limit and usage.",
			inputSchema: spendCapInput,
			outputSchema: spendCapResponse,
			annotations: {
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: false,
			},
			requiresApproval: false,
			metadata,
		},
		async (neon, { org_id }, signal) =>
			result(await spendCapApi(neon, signal).get(org_id)),
	);

export const setSpendCapTool = (options: ToolClientOptions) =>
	bindTool(
		options,
		{
			operationId: "organizations.spendingLimit.set",
			id: publishedId("organizations.spendingLimit.set"),
			title: "Set spending limit",
			description:
				toolDescriptions["organizations.spendingLimit.set"] ??
				"Sets spending limit; admin only.",
			inputSchema: setSpendCapInput,
			outputSchema: spendCapResponse,
			annotations,
			requiresApproval: true,
			metadata: { ...metadata, method: "PUT", readOnlySafe: false },
		},
		async (neon, input, signal) =>
			result(await spendCapApi(neon, signal).set(input), true),
	);

export const disableSpendCapTool = (options: ToolClientOptions) =>
	bindTool(
		options,
		{
			operationId: "organizations.spendingLimit.disable",
			id: publishedId("organizations.spendingLimit.disable"),
			title: "Disable spending limit",
			description:
				"Disables suspension; keeps limit and emails. Admin only.",
			inputSchema: spendCapInput,
			outputSchema: spendCapResponse,
			annotations,
			requiresApproval: true,
			metadata: {
				...metadata,
				method: "POST",
				path: `${metadata.path}/disable`,
				readOnlySafe: false,
			},
		},
		async (neon, { org_id }, signal) =>
			result(await spendCapApi(neon, signal).disable(org_id), true),
		{ retries: 0 },
	);
