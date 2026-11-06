import { describe, expect, it } from "vitest";
import { createNeonClient } from "../client.js";
import { NeonApiError } from "../errors.js";

function neonAnswering(body: unknown, status = 200, baseUrl?: string) {
	const requests: Request[] = [];
	const neon = createNeonClient({
		apiKey: "test-key",
		retries: 0,
		...(baseUrl === undefined ? {} : { baseUrl }),
		fetch: async (input, init) => {
			requests.push(new Request(input, init));
			return new Response(JSON.stringify(body), {
				status,
				headers: { "content-type": "application/json" },
			});
		},
	});
	return { neon, requests };
}

const streams = {
	status: "success",
	data: {
		resultType: "streams",
		result: [
			{
				stream: {
					entity_type: "function",
					service_name: "neon-function/cron",
				},
				values: [["1793988960709494000", "invoke end"]],
			},
		],
	},
	warnings: ["result truncated at 1 line"],
};

describe("logs.loki", () => {
	it("queries the telemetry API on the client's origin and returns Loki's body unchanged", async () => {
		const { neon, requests } = neonAnswering(streams);

		const { data, error } = await neon.logs.loki.queryRange({
			projectId: "p-1",
			branchId: "br-1",
			query: '{entity_type="function"} |= "error"',
			since: "30m",
			limit: 100,
			direction: "backward",
		});

		expect(error).toBeUndefined();
		expect(data).toEqual(streams);
		const url = new URL(requests[0]?.url ?? "");
		expect(requests[0]?.method).toBe("GET");
		expect(url.origin + url.pathname).toBe(
			"https://console.neon.tech/telemetry/v1/projects/p-1/branches/br-1/loki/api/v1/query_range",
		);
		expect(Object.fromEntries(url.searchParams)).toEqual({
			query: '{entity_type="function"} |= "error"',
			since: "30m",
			limit: "100",
			direction: "backward",
		});
		expect(requests[0]?.headers.get("authorization")).toBe(
			"Bearer test-key",
		);
	});

	it("keeps a custom baseUrl's origin", async () => {
		const { neon, requests } = neonAnswering(
			{ status: "success", data: [] },
			200,
			"http://localhost:4000/api/v2",
		);

		await neon.logs.loki.labels({ projectId: "p-1", branchId: "br-1" });

		expect(requests[0]?.url).toBe(
			"http://localhost:4000/telemetry/v1/projects/p-1/branches/br-1/loki/api/v1/labels",
		);
	});

	it("encodes the label name into the path", async () => {
		const { neon, requests } = neonAnswering({
			status: "success",
			data: ["neon-function/cron"],
		});

		const { data } = await neon.logs.loki.labelValues({
			projectId: "p-1",
			branchId: "br-1",
			name: "service/name",
			since: "6h",
			query: '{entity_type="function"}',
		});

		expect(data?.data).toEqual(["neon-function/cron"]);
		const url = new URL(requests[0]?.url ?? "");
		expect(url.pathname).toBe(
			"/telemetry/v1/projects/p-1/branches/br-1/loki/api/v1/label/service%2Fname/values",
		);
		expect(Object.fromEntries(url.searchParams)).toEqual({
			since: "6h",
			query: '{entity_type="function"}',
		});
	});

	it("surfaces Loki's error message", async () => {
		const { neon } = neonAnswering(
			{ status: "error", error: "logql: unsupported pipeline stage" },
			400,
		);

		const { error } = await neon.logs.loki.queryRange({
			projectId: "p-1",
			branchId: "br-1",
			query: '{entity_type="function"} | json',
		});

		expect(error).toBeInstanceOf(NeonApiError);
		expect(error?.message).toBe("logql: unsupported pipeline stage");
		await expect(
			neon.logs.loki.queryRange(
				{ projectId: "p-1", branchId: "br-1", query: "{}" },
				{ throwOnError: true },
			),
		).rejects.toThrow("logql: unsupported pipeline stage");
	});

	it("rejects a missing query before any request", async () => {
		const { neon, requests } = neonAnswering(streams);

		const { error } = await Reflect.apply(
			neon.logs.loki.queryRange,
			neon.logs.loki,
			[{ projectId: "p-1", branchId: "br-1" }],
		);

		expect(error?.message).toBe(
			"logs.loki.queryRange requires query in its parameter object (string).",
		);
		expect(requests).toEqual([]);
	});
});
