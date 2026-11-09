import { describe, expect, it } from "vitest";
import { createNeonClient } from "../client.js";
import {
	NeonAbortError,
	NeonClientError,
	NeonNetworkError,
	NeonRequestTimeoutError,
} from "../errors.js";
import { listNeonIncidents, NEON_STATUS_API_URL } from "./incidents.js";

const operational = (name: string, regions: string[]) => ({
	id: `${name}-id`,
	name,
	status: "Operational",
	status_code: 100,
	containers: regions.map((region) => ({
		id: `${region}-id`,
		name: region,
		updated: "2026-09-16T16:00:03.890Z",
		status: "Operational",
		status_code: 100,
	})),
});

// Trimmed from the live response on 2026-11-09.
const ALL_OPERATIONAL = {
	result: {
		status_overall: {
			updated: "2026-11-02T22:27:18.595Z",
			status: "Operational",
			status_code: 100,
		},
		status: [
			operational("Database Connectivity", [
				"AWS us-east-2",
				"Azure eastus2",
			]),
			operational("Console API", ["Global"]),
		],
		incidents: [],
		maintenance: { active: [], upcoming: [] },
	},
};

// Shape from https://kb.status.io/developers/public-status-api/, with Neon names.
const DISRUPTED = {
	result: {
		status_overall: {
			updated: "2026-11-09T16:45:19.810Z",
			status: "Partial Service Disruption",
			status_code: 400,
		},
		status: [
			{
				...operational("Project/Branch Operations", [
					"AWS us-east-1",
					"AWS us-east-2",
				]),
				status: "Partial Service Disruption",
				status_code: 400,
				containers: [
					{
						id: "use1",
						name: "AWS us-east-1",
						updated: "2026-11-09T16:45:19.810Z",
						status: "Operational",
						status_code: 100,
					},
					{
						id: "use2",
						name: "AWS us-east-2",
						updated: "2026-11-09T16:45:19.810Z",
						status: "Partial Service Disruption",
						status_code: 400,
					},
				],
			},
			operational("Console API", ["Global"]),
		],
		incidents: [
			{
				name: "ES-2400001",
				_id: "6b00000000000000000000aa",
				datetime_open: "2026-11-09T16:43:22.431Z",
				messages: [
					{
						details: "The issue has been identified.",
						state: 200,
						status: 400,
						datetime: "2026-11-09T16:45:19.810Z",
					},
					{
						details: "Investigating branch creation errors.",
						state: 100,
						status: 300,
						datetime: "2026-11-09T16:43:22.457Z",
					},
				],
				containers_affected: [{ name: "AWS us-east-2", _id: "use2" }],
				components_affected: [
					{ name: "Project/Branch Operations", _id: "pbo" },
				],
			},
		],
		maintenance: {
			active: [
				{
					name: "Network upgrade",
					_id: "6b00000000000000000000bb",
					datetime_open: "2026-11-09T16:48:48.491Z",
					datetime_planned_start: "2026-11-09T16:50:00.000Z",
					datetime_planned_end: "2026-11-09T17:50:00.000Z",
					messages: [
						{
							details: "Starting maintenance now.",
							state: 200,
							status: 200,
							datetime: "2026-11-09T16:49:03.798Z",
						},
					],
					containers_affected: [{ name: "Global", _id: "global" }],
					components_affected: [{ name: "Console API", _id: "api" }],
				},
			],
			upcoming: [
				{
					name: "Scheduled maintenance of our internal databases.",
					_id: "6b00000000000000000000cc",
					datetime_open: "2026-11-09T10:00:00.000Z",
					datetime_planned_start: "2026-11-12T15:00:00.000Z",
					datetime_planned_end: "2026-11-12T15:15:00.000Z",
					messages: [
						{
							details: "No downtime is expected.",
							state: 100,
							status: 200,
							datetime: "2026-11-09T10:00:00.000Z",
						},
					],
					containers_affected: [{ name: "Global", _id: "global" }],
					components_affected: [{ name: "Console API", _id: "api" }],
				},
			],
		},
	},
};

const replyWith =
	(body: unknown, status = 200): typeof fetch =>
	async () =>
		new Response(JSON.stringify(body), {
			status,
			headers: { "content-type": "application/json" },
		});

describe("listNeonIncidents", () => {
	it("reports an operational page with nothing affected", async () => {
		const urls: string[] = [];
		const headers: Headers[] = [];
		const report = await listNeonIncidents({
			fetch: async (input, init) => {
				urls.push(String(input));
				headers.push(new Headers(init?.headers));
				return replyWith(ALL_OPERATIONAL)(input, init);
			},
		});
		expect(urls).toEqual([NEON_STATUS_API_URL]);
		expect(headers[0]?.has("authorization")).toBe(false);
		expect(report).toEqual({
			status: "operational",
			updated_at: "2026-11-02T22:27:18.595Z",
			status_page_url: "https://neonstatus.com",
			incidents: [],
			maintenance: [],
			affected_components: [],
		});
	});

	it("normalizes incidents, maintenance, and affected regions", async () => {
		const report = await listNeonIncidents({ fetch: replyWith(DISRUPTED) });
		expect(report.status).toBe("partial_disruption");
		expect(report.incidents).toEqual([
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
		]);
		expect(
			report.maintenance.map((entry) => [entry.state, entry.name]),
		).toEqual([
			["active", "Network upgrade"],
			["pending", "Scheduled maintenance of our internal databases."],
		]);
		expect(report.maintenance[0]).toMatchObject({
			planned_start: "2026-11-09T16:50:00.000Z",
			planned_end: "2026-11-09T17:50:00.000Z",
			latest_update: "Starting maintenance now.",
			url: "https://status.io/pages/maintenance/6878fc85709daa75be6c7e3c/6b00000000000000000000bb",
		});
		expect(report.affected_components).toEqual([
			{
				name: "Project/Branch Operations",
				status: "partial_disruption",
				regions: ["AWS us-east-2"],
			},
		]);
	});

	it("rejects an unknown status code", async () => {
		const body = structuredClone(ALL_OPERATIONAL);
		body.result.status_overall.status_code = 700;
		await expect(
			listNeonIncidents({ fetch: replyWith(body) }),
		).rejects.toThrow(
			new NeonClientError(
				"neonstatus.com returned an unexpected response: result.status_overall.status_code has unknown code 700.",
			),
		);
	});

	it("does not echo a non-numeric code into the error message", async () => {
		for (const payload of [
			"\u001b]52;c;eA==\u0007",
			"\u009d52;c;eA==\u009c",
		]) {
			const body = structuredClone(ALL_OPERATIONAL);
			Object.assign(body.result.status_overall, { status_code: payload });
			const error = await listNeonIncidents({
				fetch: replyWith(body),
			}).catch((caught: unknown) => caught);
			expect(error).toBeInstanceOf(NeonClientError);
			expect(error).toHaveProperty(
				"message",
				"neonstatus.com returned an unexpected response: result.status_overall.status_code is not a number.",
			);
		}
	});

	it("rejects a response missing a field", async () => {
		await expect(
			listNeonIncidents({ fetch: replyWith({ result: {} }) }),
		).rejects.toThrow("result.status_overall is not an object");
	});

	it("rejects a body that is not JSON", async () => {
		await expect(
			listNeonIncidents({
				fetch: async () => new Response("<html>", { status: 200 }),
			}),
		).rejects.toThrow("neonstatus.com returned a body that is not JSON.");
	});

	it("reports a non-2xx response with its status", async () => {
		const error = await listNeonIncidents({
			fetch: replyWith({}, 503),
		}).catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(NeonClientError);
		expect(error).toHaveProperty(
			"message",
			"neonstatus.com returned HTTP 503.",
		);
	});

	it("reports a transport failure as a network error", async () => {
		const error = await listNeonIncidents({
			fetch: async () => {
				throw new TypeError("fetch failed", {
					cause: Object.assign(new Error("getaddrinfo"), {
						code: "ENOTFOUND",
					}),
				});
			},
		}).catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(NeonNetworkError);
		expect(error).toHaveProperty("reason", "ENOTFOUND");
	});

	it("times out a status page that never answers", async () => {
		const error = await listNeonIncidents({
			requestTimeoutMs: 20,
			fetch: () => new Promise<Response>(() => {}),
		}).catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(NeonRequestTimeoutError);
		expect(error).toHaveProperty("timeoutMs", 20);
	});

	it("stops when the caller aborts", async () => {
		const controller = new AbortController();
		const pending = listNeonIncidents({
			signal: controller.signal,
			fetch: () => new Promise<Response>(() => {}),
		});
		controller.abort();
		await expect(pending).rejects.toBeInstanceOf(NeonAbortError);
	});

	it("rejects an invalid requestTimeoutMs", async () => {
		await expect(
			listNeonIncidents({
				requestTimeoutMs: 0,
				fetch: replyWith(ALL_OPERATIONAL),
			}),
		).rejects.toBeInstanceOf(NeonClientError);
	});
});

describe("neon.incidents.list", () => {
	it("uses the client's fetch and returns the envelope", async () => {
		const headers: Headers[] = [];
		const neon = createNeonClient({
			apiKey: "napi-secret",
			fetch: async (input, init) => {
				headers.push(new Headers(init?.headers));
				return replyWith(ALL_OPERATIONAL)(input, init);
			},
		});
		const { data, error } = await neon.incidents.list();
		expect(error).toBeUndefined();
		expect(data?.status).toBe("operational");
		expect(headers[0]?.has("authorization")).toBe(false);
	});

	it("follows throwOnError", async () => {
		const neon = createNeonClient({
			apiKey: "napi-secret",
			throwOnError: true,
			fetch: replyWith({}, 500),
		});
		await expect(neon.incidents.list()).rejects.toBeInstanceOf(
			NeonClientError,
		);
		const result = await neon.incidents.list({ throwOnError: false });
		expect(result.error).toBeInstanceOf(NeonClientError);
	});
});
