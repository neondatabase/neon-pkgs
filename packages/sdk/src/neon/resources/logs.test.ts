import { describe, expect, it } from "vitest";
import { createNeonClient } from "../client.js";

interface Call {
	url: string;
	method: string;
	body: unknown;
}

/**
 * Build a client whose only stub is the network boundary, answering from a queue
 * so a paginated walk can be observed page by page. An unqueued request throws
 * rather than returning something plausible.
 */
function neonQueued(responses: unknown[], status = 200) {
	const calls: Call[] = [];
	const neon = createNeonClient({
		apiKey: "test",
		retries: 0,
		fetch: async (input, init) => {
			const request = input instanceof Request ? input : undefined;
			const url = request ? request.url : String(input);
			const raw = request ? await request.clone().text() : init?.body;
			calls.push({
				url,
				method: request?.method ?? init?.method ?? "GET",
				body:
					typeof raw === "string" && raw.length > 0
						? JSON.parse(raw)
						: undefined,
			});
			const body = responses[calls.length - 1];
			if (body === undefined) {
				throw new Error(`unqueued request ${calls.length} to ${url}`);
			}
			return new Response(JSON.stringify(body), {
				status,
				headers: { "content-type": "application/json" },
			});
		},
	});
	return { neon, calls };
}

const record = (message: string) => ({
	timestamp: "2026-08-08T00:00:00Z",
	message,
	attributes: {},
});

describe("logs.query pagination", () => {
	it("walks pages and replays every filter unchanged", async () => {
		const { neon, calls } = neonQueued([
			{ logs: [record("a")], next_cursor: "c1", is_truncated: true },
			{ logs: [record("b")], next_cursor: "", is_truncated: false },
		]);

		const { data, error } = await neon.logs
			.query("p-1", "br-1", { since: "1h", minimum_severity: "warn" })
			.all();

		expect(error).toBeUndefined();
		expect(data?.map((r) => r.message)).toEqual(["a", "b"]);
		expect(calls).toHaveLength(2);
		expect(calls[0]?.method).toBe("POST");
		expect(calls[0]?.url).toContain(
			"/projects/p-1/branches/br-1/logs/query",
		);
		// The endpoint returns wrong results if a page changes the filters, so the
		// cursor must be the only thing that differs between the two bodies.
		expect(calls[0]?.body).toEqual({
			since: "1h",
			minimum_severity: "warn",
		});
		expect(calls[1]?.body).toEqual({
			since: "1h",
			minimum_severity: "warn",
			cursor: "c1",
		});
	});

	it("stops at the first untruncated page even when a cursor is echoed", async () => {
		const { neon, calls } = neonQueued([
			{
				logs: [record("only")],
				next_cursor: "leftover",
				is_truncated: false,
			},
		]);

		const { data } = await neon.logs.query("p-1", "br-1").all();

		expect(data?.map((r) => r.message)).toEqual(["only"]);
		expect(calls).toHaveLength(1);
	});

	it("sends no filters when none are given", async () => {
		const { neon, calls } = neonQueued([{ logs: [], is_truncated: false }]);

		await neon.logs.query("p-1", "br-1").all();

		expect(calls[0]?.body).toEqual({});
	});

	it("keeps the filters it was given when the caller mutates them later", async () => {
		const { neon, calls } = neonQueued([
			{ logs: [record("a")], next_cursor: "c1", is_truncated: true },
			{ logs: [record("b")], is_truncated: false },
		]);
		const input = { since: "1h" };

		const page = neon.logs.query("p-1", "br-1", input);
		input.since = "6h";
		await page.all();

		expect(calls[0]?.body).toEqual({ since: "1h" });
		expect(calls[1]?.body).toEqual({ since: "1h", cursor: "c1" });
	});

	it("errors rather than truncating silently when a page cannot be resumed", async () => {
		const { neon } = neonQueued([
			{ logs: [record("a")], is_truncated: true },
		]);

		const { data, error } = await neon.logs.query("p-1", "br-1").all();

		expect(data).toBeUndefined();
		expect(error?.message).toContain("no cursor");
		// An SDK-side fault, not a 2xx masquerading as an API error.
		expect(error?.kind).toBe("client");
	});
});

describe("logs field discovery", () => {
	it("fields unwraps the field name array", async () => {
		const { neon, calls } = neonQueued([
			{ fields: ["source", "severity_text"] },
		]);

		const { data } = await neon.logs.fields("p-1", "br-1");

		expect(data).toEqual(["source", "severity_text"]);
		expect(calls[0]?.url).toContain(
			"/projects/p-1/branches/br-1/logs/fields",
		);
	});

	it("fieldValues keeps the truncation flag alongside the values", async () => {
		const { neon, calls } = neonQueued([
			{ values: ["function"], is_truncated: true },
		]);

		const { data } = await neon.logs.fieldValues("p-1", "br-1", "source", {
			since: "6h",
			limit: 1,
		});

		// Dropping is_truncated would present an arbitrary subset as the whole set.
		expect(data).toEqual({ values: ["function"], is_truncated: true });
		expect(calls[0]?.url).toContain("/logs/fields/source/values");
		expect(calls[0]?.url).toContain("since=6h");
		expect(calls[0]?.url).toContain("limit=1");
	});
});

describe("logs error propagation", () => {
	it("surfaces a branch without telemetry as a typed not-found error", async () => {
		const { neon } = neonQueued(
			[
				{
					code: "LOGS_NOT_AVAILABLE",
					message: "logs are not available for this branch",
					reason: "telemetry_not_enabled",
				},
			],
			404,
		);

		const { data, error } = await neon.logs.fields("p-1", "br-1");

		expect(data).toBeUndefined();
		expect(error?.kind).toBe("not_found");
	});
});
