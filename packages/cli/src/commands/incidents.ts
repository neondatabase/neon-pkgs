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
		.example("$0 incidents -o json", "Print the full report as JSON")
		.epilogue(
			[
				"",
				"Reads the public status page at https://neonstatus.com. No login or linked project is needed.",
			].join("\n"),
		);

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

// Status.io text is third-party input; escape sequences in it would reach the terminal.
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/g;

const clean = (text: string): string => text.replace(CONTROL_CHARACTERS, "");

function printable(report: NeonIncidentsReport): NeonIncidentsReport {
	return {
		...report,
		updated_at: clean(report.updated_at),
		incidents: report.incidents.map((incident) => ({
			...incident,
			id: clean(incident.id),
			name: clean(incident.name),
			started_at: clean(incident.started_at),
			updated_at: clean(incident.updated_at),
			latest_update: clean(incident.latest_update),
			components: incident.components.map(clean),
			regions: incident.regions.map(clean),
			url: clean(incident.url),
		})),
		maintenance: report.maintenance.map((entry) => ({
			...entry,
			id: clean(entry.id),
			name: clean(entry.name),
			planned_start: clean(entry.planned_start),
			planned_end: clean(entry.planned_end),
			latest_update: clean(entry.latest_update),
			components: entry.components.map(clean),
			regions: entry.regions.map(clean),
			url: clean(entry.url),
		})),
		affected_components: report.affected_components.map((component) => ({
			...component,
			name: clean(component.name),
			regions: component.regions.map(clean),
		})),
	};
}

export function renderReport(
	untrusted: NeonIncidentsReport,
	out: ReturnType<typeof writer>,
): void {
	const report = printable(untrusted);
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
