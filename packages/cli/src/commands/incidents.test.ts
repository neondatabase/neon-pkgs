import { PassThrough } from "node:stream";
import type { NeonIncidentsReport } from "@neon/sdk";
import { describe, expect, test } from "vitest";

import { matchErrorCode } from "../errors.js";
import { writer } from "../writer.js";
import { fetchReport, renderReport } from "./incidents.js";

const OPERATIONAL: NeonIncidentsReport = {
	status: "operational",
	updated_at: "2026-11-02T22:27:18.595Z",
	status_page_url: "https://neonstatus.com",
	incidents: [],
	maintenance: [],
	affected_components: [],
};

const DISRUPTED: NeonIncidentsReport = {
	...OPERATIONAL,
	status: "partial_disruption",
	updated_at: "2026-11-09T16:45:19.810Z",
	incidents: [
		{
			id: "6b00000000000000000000aa",
			name: "ES-2400001",
			state: "identified",
			status: "partial_disruption",
			started_at: "2026-11-09T16:43:22.431Z",
			updated_at: "2026-11-09T16:45:19.810Z",
			latest_update: "The issue has been identified.",
			components: ["Project/Branch Operations"],
			regions: ["AWS us-east-2"],
			url: "https://status.io/pages/incident/6878fc85709daa75be6c7e3c/6b00000000000000000000aa",
		},
	],
	affected_components: [
		{
			name: "Project/Branch Operations",
			status: "partial_disruption",
			regions: ["AWS us-east-2"],
		},
	],
	maintenance: [
		{
			id: "6b00000000000000000000cc",
			name: "Scheduled maintenance of our internal databases.",
			state: "pending",
			planned_start: "2026-11-12T15:00:00.000Z",
			planned_end: "2026-11-12T15:15:00.000Z",
			latest_update: "No downtime is expected.",
			components: ["Console API"],
			regions: ["Global"],
			url: "https://status.io/pages/maintenance/6878fc85709daa75be6c7e3c/6b00000000000000000000cc",
		},
	],
};

function render(report: NeonIncidentsReport): string {
	const out = new PassThrough();
	let text = "";
	out.on("data", (chunk) => {
		text += String(chunk);
	});
	renderReport(report, writer({ output: "table", out, columns: 400 }));
	return text;
}

describe("neon incidents table output", () => {
	test("says nothing is open when the page is operational", () => {
		const text = render(OPERATIONAL);
		expect(text).toContain("operational");
		expect(text).toContain("https://neonstatus.com");
		expect(text).toContain("No open incidents or maintenance.");
	});

	test("lists incidents, affected components, and maintenance", () => {
		const text = render(DISRUPTED);
		expect(text).toContain("partial_disruption");
		expect(text).toContain("Incidents");
		expect(text).toContain("ES-2400001");
		expect(text).toContain("The issue has been identified.");
		expect(text).toContain(DISRUPTED.incidents[0]?.url);
		expect(text).toContain("Affected components");
		expect(text).toContain("Maintenance");
		expect(text).toContain("2026-11-12T15:00:00.000Z");
		expect(text).not.toContain("No open incidents");
	});
});

describe("neon incidents terminal safety", () => {
	test("strips terminal control sequences from status page text", () => {
		const osc52 = "\u001b]52;c;YXR0YWNrZXI=\u0007";
		const report: NeonIncidentsReport = {
			...DISRUPTED,
			incidents: DISRUPTED.incidents.map((incident) => ({
				...incident,
				name: `\u001b[2J${incident.name}`,
				latest_update: `${osc52}Branch creation is failing.`,
				regions: ["AWS us-east-2\u009b31m"],
			})),
		};
		const text = render(report);
		expect(text).not.toMatch(
			/[\u0000-\u0009\u000b-\u001a\u001c-\u001f\u007f-\u009f]/,
		);
		expect(text).not.toContain("\u001b]52");
		expect(text).not.toContain("\u001b[2J");
		expect(text).toContain("]52;c;YXR0YWNrZXI=Branch creation is failing.");
		expect(text).toContain("ES-2400001");
	});
});

describe("fetchReport", () => {
	test("names neonstatus.com when the status page is unreachable", async () => {
		const failing: typeof fetch = async () => {
			throw Object.assign(new TypeError("fetch failed"), {
				cause: Object.assign(new Error("getaddrinfo"), {
					code: "ENOTFOUND",
				}),
			});
		};
		const error = await fetchReport({ fetch: failing }).catch(
			(caught: unknown) => caught,
		);
		expect(error).toBeInstanceOf(Error);
		expect(error).toHaveProperty(
			"message",
			"Could not reach neonstatus.com (ENOTFOUND). Check your internet connection and try again.",
		);
		expect(
			error instanceof Error ? matchErrorCode(error.message) : undefined,
		).toBe("NETWORK_ERROR");
	});
});
