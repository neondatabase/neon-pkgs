import { describe, expect, it } from "vitest";
import { createNeonClient } from "../client.js";
import {
	NeonAbortError,
	NeonApiError,
	NeonNotFoundError,
	NeonWaitTimeoutError,
} from "../errors.js";

type Call = { url: string; method: string; body: unknown };

type Reply = { status: number; body?: unknown };

function neonRouting(
	respond: (request: Call) => Reply | Promise<Reply>,
	config?: {
		retries?: number;
		waitForReadiness?: boolean;
		timeoutMs?: number;
		requestTimeoutMs?: number;
	},
) {
	const calls: Call[] = [];
	const neon = createNeonClient({
		apiKey: "test",
		retries: config?.retries ?? 0,
		waitForReadiness: config?.waitForReadiness,
		requestTimeoutMs: config?.requestTimeoutMs,
		wait: { pollIntervalMs: 1, timeoutMs: config?.timeoutMs ?? 5_000 },
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
			const { status, body } = await respond(call);
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

/** Mutations answer 202; the state reports `pending` for `pendingPolls` GETs after each. */
function realtimeBackend(pendingPolls: number) {
	let remaining = 0;
	return (call: Call) => {
		if (call.method !== "GET") {
			remaining = pendingPolls;
			return { status: 202 };
		}
		const pending = remaining > 0;
		if (pending) remaining--;
		return { status: 200, body: { enabled: true, pending } };
	};
}

const selectors = { projectId: "p-1", branchId: "br-1" };
const base = "/projects/p-1/branches/br-1/realtime";
const methods = (calls: Call[]) => calls.map((c) => c.method);

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

	it("enable sends options in the body and polls until pending is false", async () => {
		const { neon, calls } = neonRouting(realtimeBackend(2));

		const { error } = await neon.realtime.enable({
			...selectors,
			allowed_origins: ["https://app.example.com"],
		});
		expect(error).toBeUndefined();
		expect(methods(calls)).toEqual(["POST", "GET", "GET", "GET"]);
		expect(calls[0].url).toMatch(new RegExp(`${base}$`));
		expect(calls[0].body).toEqual({
			allowed_origins: ["https://app.example.com"],
		});
		expect(calls[3].url).toMatch(new RegExp(`${base}$`));
	});

	it("enable returns once queued with waitForReadiness: false", async () => {
		const { neon, calls } = neonRouting(realtimeBackend(2));
		const { error } = await neon.realtime.enable(selectors, {
			waitForReadiness: false,
		});
		expect(error).toBeUndefined();
		expect(methods(calls)).toEqual(["POST"]);
	});

	it("a client-wide waitForReadiness: false turns off enable's polling", async () => {
		const { neon, calls } = neonRouting(realtimeBackend(2), {
			waitForReadiness: false,
		});
		await neon.realtime.enable(selectors);
		expect(methods(calls)).toEqual(["POST"]);
	});

	it("accepts a JSON body on a 202", async () => {
		const { neon } = neonRouting((call) =>
			call.method === "GET"
				? { status: 200, body: { enabled: true, pending: false } }
				: { status: 202, body: {} },
		);
		const { error } = await neon.realtime.enable(selectors);
		expect(error).toBeUndefined();
	});

	it("disable returns once queued by default", async () => {
		const { neon, calls } = neonRouting(realtimeBackend(1));
		const { error } = await neon.realtime.disable(selectors);
		expect(error).toBeUndefined();
		expect(methods(calls)).toEqual(["DELETE"]);
		expect(calls[0].url).toMatch(new RegExp(`${base}$`));
	});

	it("disable polls with waitForReadiness: true", async () => {
		const { neon, calls } = neonRouting(realtimeBackend(1));
		const { error } = await neon.realtime.disable(selectors, {
			waitForReadiness: true,
		});
		expect(error).toBeUndefined();
		expect(methods(calls)).toEqual(["DELETE", "GET", "GET"]);
	});

	it("rotateSecret polls when the client sets waitForReadiness: true", async () => {
		const { neon, calls } = neonRouting(realtimeBackend(1), {
			waitForReadiness: true,
		});
		const { error } = await neon.realtime.rotateSecret(selectors);
		expect(error).toBeUndefined();
		expect(methods(calls)).toEqual(["POST", "GET", "GET"]);
		expect(calls[0].url).toMatch(new RegExp(`${base}/rotate_secret$`));
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

	it("does not retry rotateSecret on 500", async () => {
		const { neon, calls } = neonRouting(
			() => ({ status: 500, body: { message: "boom" } }),
			{ retries: 2 },
		);

		const { error } = await neon.realtime.rotateSecret(selectors);
		expect(error).toBeInstanceOf(NeonApiError);
		expect(calls).toHaveLength(1);
	});

	it("maps 404 to NeonNotFoundError without polling", async () => {
		const { neon, calls } = neonRouting(() => ({
			status: 404,
			body: { message: "Realtime is not available for this project" },
		}));
		const { error } = await neon.realtime.enable(selectors);
		expect(error).toBeInstanceOf(NeonNotFoundError);
		expect(calls).toHaveLength(1);
	});

	it("times out with NeonWaitTimeoutError while still pending", async () => {
		const { neon } = neonRouting(
			realtimeBackend(Number.POSITIVE_INFINITY),
			{
				timeoutMs: 30,
			},
		);
		const { error } = await neon.realtime.enable(selectors);
		expect(error).toBeInstanceOf(NeonWaitTimeoutError);
		expect(error).toMatchObject({ source: "wait", timeoutMs: 30 });
	});

	it("throws the timeout with throwOnError", async () => {
		const { neon } = neonRouting(
			realtimeBackend(Number.POSITIVE_INFINITY),
			{
				timeoutMs: 30,
			},
		);
		await expect(
			neon.realtime.enable(selectors, { throwOnError: true }),
		).rejects.toBeInstanceOf(NeonWaitTimeoutError);
	});

	it("times out when a poll never answers", async () => {
		const { neon } = neonRouting(
			(call) =>
				call.method === "GET"
					? new Promise<Reply>(() => {})
					: { status: 202 },
			{ timeoutMs: 30 },
		);
		const { error } = await neon.realtime.enable(selectors);
		expect(error).toBeInstanceOf(NeonWaitTimeoutError);
		expect(error).toMatchObject({ operations: [] });
	});

	it("keeps polling past requestTimeoutMs, which bounds only the request", async () => {
		const pending = realtimeBackend(8);
		const { neon, calls } = neonRouting(
			async (call) => {
				await new Promise((resolve) => setTimeout(resolve, 5));
				return pending(call);
			},
			{ requestTimeoutMs: 20 },
		);
		const { error } = await neon.realtime.enable(selectors);
		expect(error).toBeUndefined();
		expect(calls).toHaveLength(10);
	});

	it("stops polling with NeonAbortError when the signal aborts", async () => {
		const controller = new AbortController();
		let polls = 0;
		const { neon } = neonRouting((call) => {
			if (call.method !== "GET") return { status: 202 };
			polls++;
			if (polls === 2) controller.abort();
			return { status: 200, body: { enabled: true, pending: true } };
		});
		const { error } = await neon.realtime.enable(selectors, {
			signal: controller.signal,
		});
		expect(error).toBeInstanceOf(NeonAbortError);
	});

	it("surfaces a failed poll instead of reporting success", async () => {
		const { neon } = neonRouting((call) =>
			call.method === "GET"
				? { status: 500, body: { message: "boom" } }
				: { status: 202 },
		);
		const { error } = await neon.realtime.enable(selectors);
		expect(error).toBeInstanceOf(NeonApiError);
		expect(error).toMatchObject({ status: 500 });
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
		const { error } = await neon.realtime.enable({ projectId: "p-1" });
		expect(error?.message).toContain("realtime.enable");
		expect(calls).toHaveLength(0);
	});
});
