import { describe, expect, it } from "vitest";
import { createNeonClient } from "../client.js";

function neonRouting(
	respond: (request: { url: string; method: string }) => {
		status: number;
		body: unknown;
	},
) {
	const calls: Array<{ url: string; method: string }> = [];
	const neon = createNeonClient({
		apiKey: "test",
		retries: 0,
		fetch: async (input, init) => {
			const request = input instanceof Request ? input : undefined;
			const url = request ? request.url : String(input);
			const method = (
				request?.method ??
				init?.method ??
				"GET"
			).toUpperCase();
			calls.push({ url, method });
			const { status, body } = respond({ url, method });
			return new Response(JSON.stringify(body), {
				status,
				headers: { "content-type": "application/json" },
			});
		},
	});
	return { neon, calls };
}

describe("endpoints.list", () => {
	it("lists project endpoints", async () => {
		const { neon, calls } = neonRouting(() => ({
			status: 200,
			body: { endpoints: [{ id: "ep-1" }] },
		}));
		const { data, error } = await neon.postgres.endpoints.list("p-1").all();
		expect(error).toBeUndefined();
		expect(data).toEqual([{ id: "ep-1" }]);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.url).toContain("/projects/p-1/endpoints");
		expect(calls[0]?.url).not.toContain("/branches/");
	});

	it("lists endpoints for a branch", async () => {
		const { neon, calls } = neonRouting(() => ({
			status: 200,
			body: { endpoints: [{ id: "ep-2" }] },
		}));
		const { data, error } = await neon.postgres.endpoints
			.list("p-1", { branchId: "br-1" })
			.all();
		expect(error).toBeUndefined();
		expect(data).toEqual([{ id: "ep-2" }]);
		expect(calls[0]?.url).toContain(
			"/projects/p-1/branches/br-1/endpoints",
		);
	});

	it("stops after one page when the API has no cursor", async () => {
		const { neon, calls } = neonRouting(() => ({
			status: 200,
			body: { endpoints: [{ id: "ep-1" }, { id: "ep-2" }] },
		}));
		const { data, error } = await neon.postgres.endpoints.list("p-1").all();
		expect(error).toBeUndefined();
		expect(data).toHaveLength(2);
		expect(calls).toHaveLength(1);
	});

	it("returns an envelope on API error", async () => {
		const { neon } = neonRouting(() => ({
			status: 403,
			body: { message: "forbidden" },
		}));
		const { data, error } = await neon.postgres.endpoints.list("p-1").all();
		expect(data).toBeUndefined();
		expect(error?.kind).toBe("auth");
	});
});
