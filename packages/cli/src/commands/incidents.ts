import {
	type ListNeonIncidentsOptions,
	listNeonIncidents,
	type NeonIncidentsReport,
	NeonNetworkError,
} from "@neon/sdk";
import type yargs from "yargs";

import type { CommonProps } from "../types.js";
import { noPassthrough } from "../utils/flags.js";
import { writer } from "../writer.js";

export const command = "incidents";
export const describe = "Show open Neon incidents and maintenance";

export const builder = (argv: yargs.Argv) =>
	argv
		.usage("$0 incidents")
		.strict()
		.check(noPassthrough("incidents"))
		.example("$0 incidents", describe)
		.example("$0 incidents -o json", "Print the full report as JSON");

export const handler = async (props: CommonProps) => {
	const report = await fetchReport();
	if (props.output === "json" || props.output === "yaml") {
		writer(props).end(report, {
			fields: ["status", "updated_at", "status_page_url"],
		});
		return;
	}
	renderReport(report, writer(props));
};

// The global handler would rewrite a network error into "Could not reach the Neon API".
export async function fetchReport(
	options?: ListNeonIncidentsOptions,
): Promise<NeonIncidentsReport> {
	try {
		return await listNeonIncidents(options);
	} catch (error) {
		if (error instanceof NeonNetworkError) {
			throw new Error(
				`Could not reach neonstatus.com (${error.reason}). Check your internet connection and try again.`,
			);
		}
		throw error;
	}
}

export function renderReport(
	report: NeonIncidentsReport,
	out: ReturnType<typeof writer>,
): void {
	out.write(
		{
			status: report.status,
			updated_at: report.updated_at,
			status_page_url: report.status_page_url,
		},
		{ fields: ["status", "updated_at", "status_page_url"] },
	);
	if (
		report.incidents.length === 0 &&
		report.maintenance.length === 0 &&
		report.affected_components.length === 0
	) {
		out.end();
		out.text("\nNo open incidents or maintenance.\n");
		return;
	}
	if (report.incidents.length > 0) {
		out.write(report.incidents, {
			title: "Incidents",
			fields: [
				"name",
				"state",
				"status",
				"started_at",
				"components",
				"regions",
				"latest_update",
				"url",
			],
		});
	}
	if (report.affected_components.length > 0) {
		out.write(report.affected_components, {
			title: "Affected components",
			fields: ["name", "status", "regions"],
		});
	}
	if (report.maintenance.length > 0) {
		out.write(report.maintenance, {
			title: "Maintenance",
			fields: [
				"name",
				"state",
				"planned_start",
				"planned_end",
				"components",
				"regions",
				"latest_update",
				"url",
			],
		});
	}
	out.end();
}
