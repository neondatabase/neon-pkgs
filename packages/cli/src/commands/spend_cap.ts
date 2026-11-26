import {
	disableOrganizationSpendCap,
	getOrganizationSpendCap,
	type SpendingLimitResponse,
	setOrganizationSpendCap,
} from "../spend_caps_api.js";
import type { CommonProps } from "../types.js";
import { fillSingleOrg } from "../utils/enrichers.js";
import { writer } from "../writer.js";
import {
	formatUsd,
	parseUsdCents,
	SPEND_CAP_ACKNOWLEDGEMENT_NOTICE,
} from "./orgs.js";

type SpendCapProps = CommonProps & { orgId?: string };
const resolveOrg = (props: SpendCapProps) =>
	fillSingleOrg({ ...props, orgId: props.orgId ?? "" });

type SetSpendCapProps = SpendCapProps & {
	amount: string;
	spendCapEnabled?: boolean;
};

const formatCents = (cents: number | null | undefined) => {
	if (cents === null || cents === undefined) return "Unavailable";
	return formatUsd(cents);
};

const writeSpendCap = (
	props: SpendCapProps,
	data: SpendingLimitResponse,
	saved = false,
) => {
	const notice = [
		...(saved ? ["Configuration accepted."] : []),
		SPEND_CAP_ACKNOWLEDGEMENT_NOTICE,
		"Usage detection can lag by 1-2 hours; this is not a guaranteed maximum bill. Storage charges continue.",
		"Only the current open invoice counts. Billing resets on the first UTC calendar day of each month.",
	].join(" ");
	if (props.output !== "table") {
		writer(props).end({ ...data, notice }, { fields: [] });
		return;
	}
	const rows = [
		[
			"Spending limit",
			data.spending_limit_cents === null
				? "Not configured"
				: formatCents(data.spending_limit_cents),
		],
		[
			"Service suspension enabled",
			data.spend_cap_enabled === undefined
				? "Unavailable / unsupported"
				: String(data.spend_cap_enabled),
		],
		["Current invoice usage", formatCents(data.current_usage_cents)],
		["Usage observed at", data.usage_observed_at ?? "Unavailable"],
		["Invoice period ID", data.invoice_period_id ?? "Unavailable"],
		["Status", data.status ?? "Unavailable / unsupported"],
		[
			"Enforcement status",
			data.enforcement_status ?? "Unavailable / unsupported",
		],
		["Generation", data.generation?.toString() ?? "Unavailable"],
		["Period ends at", data.period_ends_at ?? "Unavailable"],
		[
			"Monitoring delay",
			data.monitoring_delay ?? "Unavailable / unsupported",
		],
		...(data.warning ? [["Warning", data.warning]] : []),
	];
	const details = Object.fromEntries(
		rows.map(([setting, value]) => [
			setting.toLowerCase().replace(/ /g, "_"),
			value,
		]),
	);
	writer(props).end(details, {
		fields: Object.keys(details),
		title: "Organization spend cap",
	});
	writer(props).text(notice + "\n");
};

export const getSpendCap = async (input: SpendCapProps) => {
	const props = await resolveOrg(input);
	writeSpendCap(props, await getOrganizationSpendCap(props));
};

export const setSpendCap = async (props: SetSpendCapProps) => {
	const body = {
		spending_limit_cents: parseUsdCents(props.amount, "org spend-cap set"),
		...(props.spendCapEnabled !== undefined
			? { spend_cap_enabled: props.spendCapEnabled }
			: {}),
	};
	writeSpendCap(
		props,
		await setOrganizationSpendCap(await resolveOrg(props), body),
		true,
	);
};

export const disableSpendCap = async (input: SpendCapProps) => {
	const props = await resolveOrg(input);
	writeSpendCap(props, await disableOrganizationSpendCap(props), true);
};
