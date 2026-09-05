import { describe, expect, it } from "vitest";
import { createNeonClient } from "./client.js";
import { NeonAbortError, NeonError } from "./errors.js";

/**
 * A fetch that stays in flight until the request's signal aborts it.
 *
 * It still settles on its own after a bounded delay. A promise that never settles is not
 * something a real `fetch` can do, and leaving one pending wedges the rest of the file.
 */
const hangingFetch: typeof fetch = (input) =>
	new Promise((resolve, reject) => {
		const signal = input instanceof Request ? input.signal : undefined;
		const fallback = setTimeout(
			() => resolve(new Response("{}", { status: 504 })),
			2_000,
		);
		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(fallback);
				reject(signal.reason ?? new Error("aborted"));
			},
			{ once: true },
		);
	});

function jsonFetch(status: number, body: unknown, headers: HeadersInit = {}) {
	let calls = 0;
	const fetchImpl: typeof fetch = async () => {
		calls += 1;
		return new Response(JSON.stringify(body), {
			status,
			headers: { "content-type": "application/json", ...headers },
		});
	};
	return { fetch: fetchImpl, calls: () => calls };
}

describe("a caller's signal reaches the request", () => {
	it("aborts an in-flight call instead of running it to completion", async () => {
		const neon = createNeonClient({
			apiKey: "k",
			retries: 0,
			fetch: hangingFetch,
		});
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 20);

		const startedAt = Date.now();
		const { data, error } = await neon.projects.get("p", {
			signal: controller.signal,
		});

		expect(Date.now() - startedAt).toBeLessThan(1_000);
		expect(data).toBeUndefined();
		expect(error?.kind).toBe("aborted");
	});

	it("reports the abort through the envelope, never as a raw DOMException", async () => {
		const neon = createNeonClient({
			apiKey: "k",
			retries: 0,
			fetch: hangingFetch,
		});
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 20);

		const result = await neon.projects
			.get("p", { signal: controller.signal })
			.catch((thrown) => ({ thrown }));

		expect(result).not.toHaveProperty("thrown");
		expect("error" in result && result.error).toBeInstanceOf(
			NeonAbortError,
		);
	});

	it("throws the typed NeonAbortError on a throwOnError client", async () => {
		const neon = createNeonClient({
			apiKey: "k",
			retries: 0,
			throwOnError: true,
			fetch: hangingFetch,
		});
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 20);

		await expect(
			neon.projects.get("p", { signal: controller.signal }),
		).rejects.toBeInstanceOf(NeonAbortError);
	});

	it("cancels a paginated walk", async () => {
		const neon = createNeonClient({
			apiKey: "k",
			retries: 0,
			fetch: hangingFetch,
		});
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 20);

		const { error } = await neon.projects
			.list(undefined, { signal: controller.signal })
			.all();
		expect(error?.kind).toBe("aborted");
	});

	it("cancels the multi-request connection-string resolver", async () => {
		const neon = createNeonClient({
			apiKey: "k",
			retries: 0,
			fetch: hangingFetch,
		});
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 20);

		const { error } = await neon.postgres.connectionString("p", undefined, {
			signal: controller.signal,
		});
		expect(error?.kind).toBe("aborted");
	});
});

describe("requestTimeoutMs bounds a call", () => {
	it("times out a request that never responds", async () => {
		const neon = createNeonClient({
			apiKey: "k",
			retries: 0,
			requestTimeoutMs: 20,
			fetch: hangingFetch,
		});

		const startedAt = Date.now();
		const { error } = await neon.projects.get("p");

		expect(Date.now() - startedAt).toBeLessThan(1_000);
		expect(error?.kind).toBe("timeout");
	});

	it("bounds a slow auth phase, which the request signal cannot reach", async () => {
		let fetched = false;
		const neon = createNeonClient({
			// Resolving the key is awaited before the request is built, so a signal
			// handed to fetch cannot bound this phase at all.
			apiKey: () =>
				new Promise<string>((resolve) =>
					setTimeout(() => resolve("k"), 2_000),
				),
			retries: 0,
			requestTimeoutMs: 20,
			fetch: async () => {
				fetched = true;
				return new Response("{}", { status: 200 });
			},
		});

		const startedAt = Date.now();
		const { error } = await neon.projects.get("p");

		expect(error?.kind).toBe("timeout");
		expect(Date.now() - startedAt).toBeLessThan(1_000);
		expect(fetched).toBe(false);
	});

	it("bounds a whole paginated walk rather than each page, so a stuck cursor cannot spin forever", async () => {
		let pages = 0;
		const neon = createNeonClient({
			apiKey: "k",
			retries: 0,
			requestTimeoutMs: 50,
			fetch: async () => {
				pages += 1;
				return new Response(
					JSON.stringify({
						projects: [{ id: `p${pages}` }],
						pagination: { cursor: "cursor-that-never-advances" },
					}),
					{
						status: 200,
						headers: { "content-type": "application/json" },
					},
				);
			},
		});

		const { error } = await neon.projects.list().all();
		expect(error?.kind).toBe("timeout");
	});

	it("is unset by default, leaving calls unbounded as before", async () => {
		const neon = createNeonClient({
			apiKey: "k",
			retries: 0,
			fetch: async () => {
				await new Promise((resolve) => setTimeout(resolve, 60));
				return new Response(JSON.stringify({ project: { id: "p" } }), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			},
		});

		const { data, error } = await neon.projects.get("p");
		expect(error).toBeUndefined();
		expect(data?.id).toBe("p");
	});

	it("lets a single call opt out of a client-wide deadline with Infinity", async () => {
		const neon = createNeonClient({
			apiKey: "k",
			retries: 0,
			requestTimeoutMs: 20,
			fetch: async () => {
				await new Promise((resolve) => setTimeout(resolve, 60));
				return new Response(JSON.stringify({ project: { id: "p" } }), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			},
		});

		const { error } = await neon.projects.get("p", {
			requestTimeoutMs: Number.POSITIVE_INFINITY,
		});
		expect(error).toBeUndefined();
	});

	it("refuses a timeout setTimeout would mistreat, at construction", () => {
		expect(() =>
			createNeonClient({ apiKey: "k", requestTimeoutMs: 0 }),
		).toThrow(NeonError);
		expect(() =>
			createNeonClient({ apiKey: "k", requestTimeoutMs: -5 }),
		).toThrow(/positive number/);
		expect(() =>
			createNeonClient({ apiKey: "k", requestTimeoutMs: Number.NaN }),
		).toThrow(/positive number/);
	});
});

describe("retry scheduling", () => {
	it("aborts during the backoff sleep through the envelope, not as a DOMException", async () => {
		// The one path where a signal already had an effect before this change: it
		// interrupted the sleep by rejecting, escaping the result contract entirely.
		const rateLimited = jsonFetch(429, { message: "slow down" });
		const neon = createNeonClient({
			apiKey: "k",
			retries: 8,
			fetch: rateLimited.fetch,
		});
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 20);

		const result = await neon.projects
			.get("p", { signal: controller.signal })
			.catch((thrown) => ({ thrown }));

		expect(result).not.toHaveProperty("thrown");
		expect("error" in result && result.error?.kind).toBe("aborted");
	});

	it("throws NeonAbortError rather than a DOMException when backoff is aborted", async () => {
		const rateLimited = jsonFetch(429, { message: "slow down" });
		const neon = createNeonClient({
			apiKey: "k",
			retries: 8,
			throwOnError: true,
			fetch: rateLimited.fetch,
		});
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 20);

		await expect(
			neon.projects.get("p", { signal: controller.signal }),
		).rejects.toBeInstanceOf(NeonAbortError);
	});

	it("stops retrying rather than waiting out an hour-long Retry-After", async () => {
		const rateLimited = jsonFetch(
			429,
			{ message: "slow down" },
			{ "retry-after": "3600" },
		);
		const neon = createNeonClient({
			apiKey: "k",
			retries: 3,
			fetch: rateLimited.fetch,
		});

		const startedAt = Date.now();
		const { error } = await neon.projects.get("p");

		// The real 429 is surfaced instead of being hidden behind a long sleep or a
		// timeout, and the header is never shortened into an early retry.
		expect(Date.now() - startedAt).toBeLessThan(1_000);
		expect(error?.kind).toBe("rate_limit");
		expect(rateLimited.calls()).toBe(1);
	});

	it("still retries a short Retry-After", async () => {
		const rateLimited = jsonFetch(
			429,
			{ message: "slow down" },
			{ "retry-after": "0" },
		);
		const neon = createNeonClient({
			apiKey: "k",
			retries: 2,
			fetch: rateLimited.fetch,
		});

		await neon.projects.get("p");
		expect(rateLimited.calls()).toBe(3);
	});
});
