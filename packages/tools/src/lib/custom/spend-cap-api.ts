import type { NeonClient } from "@neon/sdk";
import * as z from "zod";

// Public int64 amounts must stay exact when represented as JavaScript numbers.
const cents = z.int().min(1);

export const spendCapInput = z.strictObject({
	org_id: z.string().min(1).describe("Org id."),
});

export const setSpendCapInput = spendCapInput.extend({
	spending_limit_cents: cents.describe("USD cents: 100 = $1."),
	spend_cap_enabled: z
		.boolean()
		.optional()
		.describe("True opts in; false keeps emails. Omit preserves."),
});

export const spendCapResponse = z.looseObject({
	spending_limit_cents: cents.nullable(),
	spend_cap_enabled: z.boolean().nullish(),
	current_usage_cents: z.int().min(0).nullish(),
	usage_observed_at: z.iso.datetime({ offset: true }).nullish(),
	invoice_period_id: z.string().nullish(),
	status: z.enum(["off", "active", "approaching", "reached"]).nullish(),
	enforcement_status: z.enum(["off", "pending", "applied"]).nullish(),
	generation: z.int().min(0).nullish(),
	period_ends_at: z.iso.datetime({ offset: true }).nullish(),
	monitoring_delay: z.string().nullish(),
	warning: z.string().nullish(),
});

/** Typed adapter for the additive API fields not yet in the SDK's generated spec. */
export const spendCapApi = (neon: NeonClient<true>, signal?: AbortSignal) => {
	const path = (orgId: string) =>
		`/organizations/${encodeURIComponent(orgId)}/billing/spending_limit`;
	return {
		async get(orgId: string) {
			return spendCapResponse.parse(
				await neon.request(
					{ method: "GET", path: path(orgId) },
					{ signal },
				),
			);
		},
		async set(input: z.infer<typeof setSpendCapInput>) {
			const { org_id, ...body } = input;
			return spendCapResponse.parse(
				await neon.request(
					{ method: "PUT", path: path(org_id), body },
					{ signal },
				),
			);
		},
	};
};
