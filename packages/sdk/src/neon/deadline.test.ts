import { getEventListeners } from "node:events";
import { describe, expect, it } from "vitest";
import { cancelled, createDeadline, delay, runBounded } from "./deadline.js";

describe("delay", () => {
	it("reports elapsed when it runs to completion", async () => {
		expect(await delay(5)).toBe("elapsed");
	});

	it("reports cancelled instead of rejecting, so no DOMException escapes", async () => {
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 5);
		expect(await delay(60_000, controller.signal)).toBe("cancelled");
	});

	it("reports cancelled immediately for an already-aborted signal", async () => {
		expect(await delay(60_000, AbortSignal.abort())).toBe("cancelled");
	});

	it("removes its abort listener either way, so repeated waits don't accumulate", async () => {
		const controller = new AbortController();
		for (let i = 0; i < 25; i++) await delay(1, controller.signal);
		// Node warns past 10 listeners on one target; a leak here would be a poller that
		// degrades the longer it runs.
		expect(getEventListeners(controller.signal, "abort").length).toBe(0);
	});
});

describe("createDeadline", () => {
	it("is unbounded and allocates no signal when nothing can cancel it", () => {
		const deadline = createDeadline(Number.POSITIVE_INFINITY);
		expect(deadline.signal).toBeUndefined();
		expect(deadline.timeoutMs).toBeUndefined();
		expect(deadline.remainingMs()).toBe(Number.POSITIVE_INFINITY);
		expect(deadline.source()).toBeUndefined();
	});

	it("still exposes a signal when unbounded but given a caller signal", () => {
		const controller = new AbortController();
		const deadline = createDeadline(
			Number.POSITIVE_INFINITY,
			controller.signal,
		);
		expect(deadline.signal).toBeDefined();
		expect(deadline.timeoutMs).toBeUndefined();
		expect(deadline.remainingMs()).toBe(Number.POSITIVE_INFINITY);
		deadline.dispose();
	});

	it("names the timeout as the source and aborts its signal", async () => {
		const deadline = createDeadline(5);
		await deadline.fired();
		expect(deadline.source()).toBe("timeout");
		expect(deadline.timeoutMs).toBe(5);
		expect(deadline.signal?.aborted).toBe(true);
		deadline.dispose();
	});

	it("names the caller as the source, distinguishing cancellation from a timeout", async () => {
		const controller = new AbortController();
		const deadline = createDeadline(60_000, controller.signal);
		controller.abort();
		await deadline.fired();
		expect(deadline.source()).toBe("caller");
		deadline.dispose();
	});

	it("trips immediately on a signal that was already aborted", () => {
		const deadline = createDeadline(60_000, AbortSignal.abort());
		expect(deadline.source()).toBe("caller");
		expect(deadline.signal?.aborted).toBe(true);
		deadline.dispose();
	});

	it("counts the budget down and floors it at zero", async () => {
		const deadline = createDeadline(50);
		expect(deadline.remainingMs()).toBeLessThanOrEqual(50);
		await delay(70);
		expect(deadline.remainingMs()).toBe(0);
		deadline.dispose();
	});

	it("expires from the clock even when the timer never gets a turn", async () => {
		const deadline = createDeadline(5);
		// Awaiting already-resolved promises drains the microtask queue without ever
		// reaching the timer phase, so a deadline that only trusted its timer would never
		// fire here and the caller would spin forever.
		let iterations = 0;
		while (!deadline.source() && iterations < 1_000_000) {
			await Promise.resolve();
			iterations++;
		}
		expect(deadline.source()).toBe("timeout");
		expect(deadline.signal?.aborted).toBe(true);
		deadline.dispose();
	});

	it("does not fire early for a budget larger than setTimeout can represent", async () => {
		// setTimeout collapses any delay above 2^31-1 to 1ms, so a single timer would
		// have expired this deadline almost immediately.
		const deadline = createDeadline(2 ** 31 + 1_000);
		await delay(30);
		expect(deadline.source()).toBeUndefined();
		expect(deadline.remainingMs()).toBeGreaterThan(2 ** 31 - 1);
		deadline.dispose();
	});

	it("releases the caller-signal listener on dispose", () => {
		const controller = new AbortController();
		const deadline = createDeadline(60_000, controller.signal);
		expect(
			getEventListeners(controller.signal, "abort").length,
		).toBeGreaterThan(0);
		deadline.dispose();
		expect(getEventListeners(controller.signal, "abort").length).toBe(0);
	});
});

describe("cancelled", () => {
	it("maps a timeout to a timeout error", async () => {
		const deadline = createDeadline(1);
		await deadline.fired();
		const error = cancelled(deadline);
		expect(error?.kind).toBe("timeout");
		expect(error).toMatchObject({ source: "request", timeoutMs: 1 });
		deadline.dispose();
	});

	it("maps a caller abort to an abort error", async () => {
		const deadline = createDeadline(60_000, AbortSignal.abort());
		expect(cancelled(deadline)?.kind).toBe("aborted");
		deadline.dispose();
	});

	it("returns undefined while the deadline has not fired", () => {
		const deadline = createDeadline(60_000);
		expect(cancelled(deadline)).toBeUndefined();
		deadline.dispose();
	});
});

describe("runBounded", () => {
	it("returns the value when the work wins", async () => {
		const deadline = createDeadline(60_000);
		expect(await runBounded(deadline, async () => "done")).toBe("done");
		deadline.dispose();
	});

	it("resolves undefined when the deadline wins, without waiting for the work", async () => {
		const deadline = createDeadline(5);
		const startedAt = Date.now();
		const result = await runBounded(
			deadline,
			() => new Promise<string>((resolve) => setTimeout(resolve, 60_000)),
		);
		expect(result).toBeUndefined();
		expect(Date.now() - startedAt).toBeLessThan(1_000);
		deadline.dispose();
	});

	it("does not leave an unhandled rejection behind when the deadline wins", async () => {
		const deadline = createDeadline(5);
		await runBounded(deadline, async () => {
			await delay(20);
			throw new Error("late failure the caller never saw");
		});
		// The abandoned work rejects after the race is decided; if that rejection were
		// unhandled it would surface here as an unhandled-rejection failure.
		await delay(60);
		deadline.dispose();
	});
});
