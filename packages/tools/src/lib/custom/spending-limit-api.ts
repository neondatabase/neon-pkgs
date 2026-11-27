import type { NeonClient } from "@neon/sdk";
import * as z from "zod";

// Public int64 amounts must stay exact when represented as JavaScript numbers.
const cents = z.int().min(1);

export const spendingLimitInput = z.strictObject({
	org_id: z.string().min(1).describe("Org id."),
});

export const setSpendingLimitInput = spendingLimitInput.extend({
	spending_limit_cents: cents.describe("USD cents: 100 = $1."),
	spending_limit_enabled: z
		.boolean()
		.optional()
		.describe(
			"Omit: new suspension on when available; existing preserves. False: emails only; true: suspension.",
		),
});

export const spendingLimitResponse = z.looseObject({
	spending_limit_cents: cents.nullable(),
	spending_limit_enabled: z.boolean().nullish(),
	current_usage_cents: z.int().min(0).nullish(),
	usage_observed_at: z.iso.datetime({ offset: true }).nullish(),
	invoice_period_id: z.string().nullish(),
	// New server states must not hide an accepted configuration and its warning.
	status: z.string().nullish(),
	enforcement_status: z.string().nullish(),
	generation: z.int().min(0).nullish(),
	period_ends_at: z.iso.datetime({ offset: true }).nullish(),
	monitoring_delay: z.string().nullish(),
	warning: z.string().nullish(),
});

/** Typed adapter for the additive API fields not yet in the SDK's generated spec. */
export const spendingLimitApi = (
	neon: NeonClient<true>,
	signal?: AbortSignal,
) => {
	const path = (orgId: string) =>
		`/organizations/${encodeURIComponent(orgId)}/billing/spending_limit`;
	return {
		async disable(orgId: string) {
			return spendingLimitResponse.parse(
				await neon.request(
					{ method: "POST", path: `${path(orgId)}/disable` },
					{ signal },
				),
			);
		},
		async get(orgId: string) {
			return spendingLimitResponse.parse(
				await neon.request(
					{ method: "GET", path: path(orgId) },
					{ signal },
				),
			);
		},
		async set(input: z.infer<typeof setSpendingLimitInput>) {
			const { org_id, ...body } = input;
			return spendingLimitResponse.parse(
				await neon.request(
					{ method: "PUT", path: path(org_id), body },
					{ signal },
				),
			);
		},
	};
};
