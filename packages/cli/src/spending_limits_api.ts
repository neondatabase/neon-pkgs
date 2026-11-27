import { fromSdkError, getNeonClient } from "./neon_client.js";
import type { OrgScopeProps } from "./types.js";

// Keep this narrow adapter until the SDK's spendingLimit namespace includes the suspension setting.
export type SpendingLimitResponse = {
	spending_limit_cents: number | null;
	spending_limit_enabled?: boolean;
	current_usage_cents?: number | null;
	usage_observed_at?: string | null;
	invoice_period_id?: string;
	status?: string;
	enforcement_status?: string;
	generation?: number;
	period_ends_at?: string;
	monitoring_delay?: string;
	warning?: string;
};

type SpendingLimitUpdate = {
	spending_limit_cents: number;
	spending_limit_enabled?: boolean;
};

const validateResponse = (data: unknown): SpendingLimitResponse => {
	if (
		!data ||
		typeof data !== "object" ||
		!("spending_limit_cents" in data)
	) {
		throw new Error("The API response is missing spending_limit_cents.");
	}
	// JSON numbers outside this range cannot be displayed or written back exactly.
	for (const field of [
		"spending_limit_cents",
		"current_usage_cents",
		"generation",
	] as const) {
		const value = (data as Record<string, unknown>)[field];
		if (
			value !== undefined &&
			value !== null &&
			(typeof value !== "number" ||
				!Number.isSafeInteger(value) ||
				value < 0)
		) {
			throw new Error(
				`The API returned an unsupported ${field}; expected a non-negative safe integer.`,
			);
		}
	}
	if (data.spending_limit_cents === undefined) {
		throw new Error("The API response is missing spending_limit_cents.");
	}
	if (
		"spending_limit_enabled" in data &&
		typeof data.spending_limit_enabled !== "boolean"
	) {
		throw new Error(
			"The API returned an unsupported spending_limit_enabled.",
		);
	}
	for (const field of [
		"usage_observed_at",
		"invoice_period_id",
		"status",
		"enforcement_status",
		"period_ends_at",
		"monitoring_delay",
		"warning",
	] as const) {
		const value = (data as Record<string, unknown>)[field];
		if (
			value !== undefined &&
			!(field === "usage_observed_at" && value === null) &&
			typeof value !== "string"
		) {
			throw new Error(`The API returned an unsupported ${field}.`);
		}
	}
	return data as SpendingLimitResponse;
};

const spendingLimitPath = (orgId: string) =>
	`/organizations/${encodeURIComponent(orgId)}/billing/spending_limit`;

const request = async (
	props: OrgScopeProps,
	method: "GET" | "PUT" | "POST",
	body?: SpendingLimitUpdate,
): Promise<SpendingLimitResponse> => {
	const data = await getNeonClient(
		props,
		method === "POST" ? { retries: 0 } : undefined,
	)
		.request({
			path: `${spendingLimitPath(props.orgId)}${method === "POST" ? "/disable" : ""}`,
			method,
			...(body === undefined ? {} : { body }),
		})
		.catch((error: unknown) => {
			throw fromSdkError(error, props.apiHost);
		});
	return validateResponse(data);
};

export const getOrganizationSpendingLimit = (
	props: OrgScopeProps,
): Promise<SpendingLimitResponse> => request(props, "GET");

export const disableOrganizationSpendingLimit = (
	props: OrgScopeProps,
): Promise<SpendingLimitResponse> => request(props, "POST");

export const setOrganizationSpendingLimit = (
	props: OrgScopeProps,
	body: SpendingLimitUpdate,
): Promise<SpendingLimitResponse> => {
	if (
		!Number.isSafeInteger(body.spending_limit_cents) ||
		body.spending_limit_cents < 1
	) {
		throw new Error(
			"spending_limit_cents must be a positive safe integer.",
		);
	}
	return request(props, "PUT", body);
};
