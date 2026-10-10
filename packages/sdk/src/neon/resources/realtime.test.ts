import { describe, expect, it } from "vitest";
import { createNeonClient } from "../client.js";
import { NeonApiError, NeonNotFoundError } from "../errors.js";

function neonRouting(
	respond: (request: { url: string; method: string; body: unknown }) => {
		status: number;
		body?: unknown;
	},
	config?: { retries?: number },
) {
	const calls: Array<{ url: string; method: string; body: unknown }> = [];
	const neon = createNeonClient({
		apiKey: "test",
		retries: config?.retries ?? 0,
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
			if (body === undefined) {
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

const selectors = { projectId: "p-1", branchId: "br-1" };
const base = "/projects/p-1/branches/br-1/realtime";

describe("realtime", () => {
	it("gets the branch state", async () => {
		const state = {
			enabled: true,
			pending: false,
			invocation_url: "wss://realtime.example.neon.tech",
			revision: 3,
			allowed_origins: ["https://app.example.com"],
		};
		const { neon, calls } = neonRouting(() => ({
			status: 200,
			body: state,
		}));

		const { data, error } = await neon.realtime.get(selectors);
		expect(error).toBeUndefined();
		expect(data).toEqual(state);
		expect(calls[0].method).toBe("GET");
		expect(calls[0].url).toMatch(new RegExp(`${base}$`));
	});

	it("enables with options in the body and selectors in the path", async () => {
		const { neon, calls } = neonRouting(() => ({ status: 202 }));

		const { error } = await neon.realtime.enable({
			...selectors,
			allowed_origins: ["https://app.example.com"],
		});
		expect(error).toBeUndefined();
		expect(calls[0].method).toBe("POST");
		expect(calls[0].url).toMatch(new RegExp(`${base}$`));
		expect(calls[0].body).toEqual({
			allowed_origins: ["https://app.example.com"],
		});
	});

	it("accepts a JSON body on a 202", async () => {
		const { neon } = neonRouting(() => ({ status: 202, body: {} }));
		const { error } = await neon.realtime.enable(selectors);
		expect(error).toBeUndefined();
	});

	it("disables with DELETE", async () => {
		const { neon, calls } = neonRouting(() => ({ status: 202 }));
		const { error } = await neon.realtime.disable(selectors);
		expect(error).toBeUndefined();
		expect(calls[0].method).toBe("DELETE");
		expect(calls[0].url).toMatch(new RegExp(`${base}$`));
	});

	it("reads the secret with its pending flag", async () => {
		const secret = { secret: "nrt_live_1abc", pending: false };
		const { neon, calls } = neonRouting(() => ({
			status: 200,
			body: secret,
		}));

		const { data, error } = await neon.realtime.secret(selectors);
		expect(error).toBeUndefined();
		expect(data).toEqual(secret);
		expect(calls[0].method).toBe("GET");
		expect(calls[0].url).toMatch(new RegExp(`${base}/secret$`));
	});

	it("rotates the secret with POST and no retry on 500", async () => {
		const { neon, calls } = neonRouting(
			() => ({ status: 500, body: { message: "boom" } }),
			{ retries: 2 },
		);

		const { error } = await neon.realtime.rotateSecret(selectors);
		expect(error).toBeInstanceOf(NeonApiError);
		expect(calls).toHaveLength(1);
		expect(calls[0].method).toBe("POST");
		expect(calls[0].url).toMatch(new RegExp(`${base}/rotate_secret$`));
	});

	it("maps 404 to NeonNotFoundError", async () => {
		const { neon } = neonRouting(() => ({
			status: 404,
			body: { message: "Realtime is not available for this project" },
		}));
		const { error } = await neon.realtime.enable(selectors);
		expect(error).toBeInstanceOf(NeonNotFoundError);
	});

	it("branches.create and projects.create forward realtime options", async () => {
		const { neon, calls } = neonRouting(({ url }) =>
			url.endsWith("/branches")
				? {
						status: 201,
						body: { branch: { id: "br-2" }, operations: [] },
					}
				: {
						status: 201,
						body: { project: { id: "p-2" }, operations: [] },
					},
		);
		const realtime = { allowed_origins: ["https://app.example.com"] };

		await neon.branches.create({ projectId: "p-1", realtime });
		await neon.projects.create({ name: "app", realtime });
		expect(calls[0].body).toMatchObject({ branch: { realtime } });
		expect(calls[1].body).toMatchObject({ project: { realtime } });
	});

	it("rejects a missing branchId before any request", async () => {
		const { neon, calls } = neonRouting(() => ({ status: 200, body: {} }));
		// @ts-expect-error runtime guard for JS callers
		const { error } = await neon.realtime.get({ projectId: "p-1" });
		expect(error?.message).toContain("realtime.get");
		expect(calls).toHaveLength(0);
	});
});
