import { describe, expect, it } from "vitest";
import { createNeonClient } from "../client.js";

function neonRouting(
	respond: (request: { url: string; method: string; body: unknown }) => {
		status: number;
		body?: unknown;
	},
) {
	const calls: Array<{ url: string; method: string; body: unknown }> = [];
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
			const raw = request ? await request.clone().text() : init?.body;
			const call = {
				url,
				method,
				body:
					typeof raw === "string" && raw.length > 0
						? JSON.parse(raw)
						: raw,
			};
			calls.push(call);
			const { status, body } = respond(call);
			if (status === 204) {
				return new Response(null, { status });
			}
			return new Response(JSON.stringify(body), {
				status,
				headers: { "content-type": "application/json" },
			});
		},
	});
	return { neon, calls };
}

const domain = {
	domain: "docs.example.com",
	entity_type: "function",
	entity_id: "api",
	cname_target: "abc.custom.neon.tech",
};

describe("functions.customDomains", () => {
	it("lists pages from custom_domains and pagination.next", async () => {
		const { neon, calls } = neonRouting((request) => {
			if (request.url.includes("cursor=page-2")) {
				return {
					status: 200,
					body: {
						custom_domains: [
							{
								...domain,
								domain: "app.example.com",
								entity_id: "app",
							},
						],
					},
				};
			}
			return {
				status: 200,
				body: {
					custom_domains: [domain],
					pagination: { next: "page-2" },
				},
			};
		});

		const { data, error } = await neon.functions.customDomains
			.list("p-1", "br-1")
			.all();

		expect(error).toBeUndefined();
		expect(data).toEqual([
			domain,
			{ ...domain, domain: "app.example.com", entity_id: "app" },
		]);
		expect(calls).toHaveLength(2);
		expect(calls[0].method).toBe("GET");
		expect(calls[0].url).toContain(
			"/projects/p-1/branches/br-1/custom-domains",
		);
		expect(calls[1].url).toContain("cursor=page-2");
	});

	it("registers with the request body and returns the CustomDomain", async () => {
		const { neon, calls } = neonRouting(() => ({
			status: 201,
			body: domain,
		}));

		const { data, error } = await neon.functions.customDomains.register(
			"p-1",
			"br-1",
			{
				domain: "docs.example.com",
				entity_type: "function",
				entity_id: "api",
			},
		);

		expect(error).toBeUndefined();
		expect(data).toEqual(domain);
		expect(calls).toHaveLength(1);
		expect(calls[0].method).toBe("POST");
		expect(calls[0].body).toEqual({
			domain: "docs.example.com",
			entity_type: "function",
			entity_id: "api",
		});
	});

	it("deletes with a 204", async () => {
		const { neon, calls } = neonRouting(() => ({ status: 204 }));

		const { error } = await neon.functions.customDomains.delete(
			"p-1",
			"br-1",
			"docs.example.com",
		);

		expect(error).toBeUndefined();
		expect(calls).toHaveLength(1);
		expect(calls[0].method).toBe("DELETE");
		expect(calls[0].url).toContain(
			"/projects/p-1/branches/br-1/custom-domains/docs.example.com",
		);
	});
});
