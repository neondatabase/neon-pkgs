import type * as z from "zod";
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
			title: "Get spend cap",
			description: "Gets org cap status and usage.",
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
			title: "Set spend cap",
			description: "Sets org cap; admins only.",
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
			title: "Disable spend cap",
			description:
				"Disables cap, keeping amount and emails; admin required.",
			inputSchema: spendCapInput,
			outputSchema: spendCapResponse,
			annotations,
			requiresApproval: true,
			metadata: { ...metadata, method: "PUT", readOnlySafe: false },
		},
		async (neon, { org_id }, signal) => {
			const api = spendCapApi(neon, signal);
			const current = await api.get(org_id);
			if (current.spending_limit_cents === null) return result(current);
			return result(
				await api.set({
					org_id,
					spending_limit_cents: current.spending_limit_cents,
					spend_cap_enabled: false,
				}),
				true,
			);
		},
	);
