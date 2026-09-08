/**
 * Cancellation and deadline plumbing shared by the ergonomic layer.
 *
 * Two facts shape this module. Handing a signal to `fetch` does **not** bound a call: the
 * generated client awaits authentication and request interceptors before it constructs the
 * `Request` (see `client/client/client.gen.ts`), and a caller-supplied `fetch` may ignore
 * the signal entirely. So a deadline both carries a signal *and* offers {@link Deadline.fired}
 * to race the whole execution against.
 *
 * And a cancelled call must still speak the result contract. Anything that waits here
 * reports cancellation as a value rather than rejecting, so a `DOMException` never escapes
 * to a caller who was promised `{ data, error }`.
 */

import { NeonAbortError, NeonClientError, NeonTimeoutError } from "./errors.js";

/**
 * The largest delay `setTimeout` can represent. Beyond it Node warns
 * (`TimeoutOverflowWarning`) and fires after 1ms instead, which would turn a deliberately
 * generous deadline into an instant timeout.
 */
const MAX_TIMER_MS = 2 ** 31 - 1;

/** Why a bounded wait ended. */
export type DelayOutcome = "elapsed" | "cancelled";

/** What ended a call: the caller's own signal, or the request-timeout budget. */
export type DeadlineSource = "caller" | "timeout";

export interface Deadline {
	/**
	 * Attach to every request the call makes. `undefined` when the call is unbounded and
	 * the caller passed no signal, so nothing extra is allocated for the common case.
	 */
	readonly signal: AbortSignal | undefined;
	/** Budget left in milliseconds; `Infinity` when no request timeout applies. */
	remainingMs(): number;
	/**
	 * What ended the call, or `undefined` while it may still proceed.
	 *
	 * Reads the clock rather than trusting the timer to have run, and trips the deadline
	 * itself if the budget is already spent. A loop that only ever awaits
	 * already-resolved promises — paginating a cursor the API keeps repeating, say —
	 * yields to the microtask queue but never to the timer phase, so a timer-only
	 * deadline would never fire and the call would spin forever.
	 */
	source(): DeadlineSource | undefined;
	/**
	 * Resolves when the deadline fires, and otherwise never settles. Used to bound the
	 * phases a request signal cannot reach. Never rejects.
	 */
	fired(): Promise<void>;
	/** Release the timer and the caller-signal listener. Safe to call more than once. */
	dispose(): void;
}

const UNBOUNDED: Deadline = {
	signal: undefined,
	remainingMs: () => Number.POSITIVE_INFINITY,
	source: () => undefined,
	fired: () => new Promise<void>(() => {}),
	dispose: () => {},
};

/**
 * Normalize a `requestTimeoutMs`, rejecting values `setTimeout` would mistreat.
 *
 * Shared by the client config and by per-call overrides — validating only at construction
 * left `requestTimeoutMs: NaN` on a call silently meaning *unbounded*, and a value past
 * {@link MAX_TIMER_MS} silently meaning *1ms*. Both are worse than an error, because the
 * call still returns a plausible-looking result.
 *
 * `undefined` and `Infinity` both mean unbounded; `Infinity` is the documented way to opt
 * a single call out of a client-wide deadline.
 */
export function resolveTimeoutMs(value: number | undefined): number {
	if (value === undefined || value === Number.POSITIVE_INFINITY) {
		return Number.POSITIVE_INFINITY;
	}
	if (typeof value !== "number" || Number.isNaN(value) || value <= 0) {
		throw new NeonClientError(
			`requestTimeoutMs must be a positive number of milliseconds, or Infinity to disable; received ${String(value)}.`,
		);
	}
	if (value > MAX_TIMER_MS) {
		throw new NeonClientError(
			`requestTimeoutMs must be at most ${MAX_TIMER_MS}ms (about 24.8 days); received ${value}. Pass Infinity for no deadline.`,
		);
	}
	return value;
}

/**
 * The typed error for a deadline that has fired, or `undefined` if it has not.
 *
 * Cancellation is classified from the deadline's own state rather than from the shape of
 * the error that came back. The generated client funnels authentication, serialization,
 * interceptor, transport and parsing faults through one channel, so an error merely named
 * `AbortError` is not evidence that the caller cancelled.
 */
export function cancelled(
	deadline: Deadline,
): NeonAbortError | NeonTimeoutError | undefined {
	const source = deadline.source();
	if (source === "caller") {
		return new NeonAbortError("The request was aborted by its signal.");
	}
	if (source === "timeout") {
		return new NeonTimeoutError(
			"Timed out waiting for the Neon API to respond (requestTimeoutMs).",
		);
	}
	return undefined;
}

/**
 * Race `run()` against the deadline, resolving `undefined` when the deadline wins.
 *
 * The signal alone does not bound a call. The generated client awaits authentication and
 * request interceptors before it constructs the `Request`, and a caller-supplied `fetch`
 * need not honour a signal at all, so an `apiKey` function that never resolves would
 * otherwise hang forever even with a deadline set.
 */
export async function runBounded<T>(
	deadline: Deadline,
	run: () => Promise<T>,
): Promise<T | undefined> {
	if (!deadline.signal) return run();
	const execution = run();
	// The losing arm still settles later. Without a handler, its rejection is reported as
	// unhandled once the deadline has already answered the caller.
	execution.catch(() => {});
	return Promise.race([execution, deadline.fired().then(() => undefined)]);
}

/**
 * Wait `ms`, or stop early when `signal` aborts. Resolves either way — an abort is
 * reported as `"cancelled"` rather than thrown, and the listener is always removed so a
 * long-lived caller signal doesn't accumulate one per wait.
 */
export function delay(ms: number, signal?: AbortSignal): Promise<DelayOutcome> {
	if (signal?.aborted) return Promise.resolve("cancelled");
	return new Promise<DelayOutcome>((resolve) => {
		const onAbort = () => {
			clearTimeout(timer);
			resolve("cancelled");
		};
		const timer = setTimeout(() => {
			signal?.removeEventListener("abort", onAbort);
			resolve("elapsed");
		}, ms);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

/**
 * Build the deadline for one call.
 *
 * `timeoutMs` is `Infinity` when no request timeout applies. With no timeout and no caller
 * signal there is nothing to cancel, so a shared no-op deadline is returned and no timer
 * or controller is allocated.
 */
export function createDeadline(
	timeoutMs: number,
	callerSignal?: AbortSignal,
): Deadline {
	const bounded = Number.isFinite(timeoutMs);
	if (!bounded && !callerSignal) return UNBOUNDED;

	// Monotonic: a wall-clock jump (NTP correction, manual change) would otherwise expire
	// a deadline early or extend one whose timer is being starved.
	const startedAt = performance.now();
	const controller = new AbortController();
	let source: DeadlineSource | undefined;
	let notify: (() => void) | undefined;
	const fired = new Promise<void>((resolve) => {
		notify = resolve;
	});

	const trip = (reason: DeadlineSource) => {
		if (source) return;
		source = reason;
		controller.abort();
		notify?.();
	};

	if (callerSignal?.aborted) trip("caller");

	const onCallerAbort = () => trip("caller");
	const remainingMs = () =>
		bounded
			? Math.max(0, timeoutMs - (performance.now() - startedAt))
			: Number.POSITIVE_INFINITY;

	// Deliberately not `unref`ed: every deadline is disposed in a `finally`, so it cannot
	// outlive its call, and an unref'd timer is invisible to the event loop's liveness
	// accounting — a call whose only pending work is the deadline would starve instead of
	// timing out.
	//
	// Re-armed in chunks rather than scheduled once, because `setTimeout` silently
	// collapses any delay above MAX_TIMER_MS to 1ms. `wait.timeoutMs` has always accepted
	// arbitrarily large budgets, and a single timer would have turned one into an instant
	// timeout.
	let timer: ReturnType<typeof setTimeout> | undefined;
	const arm = () => {
		const left = remainingMs();
		if (left === 0) return trip("timeout");
		timer = setTimeout(
			left > MAX_TIMER_MS ? arm : () => trip("timeout"),
			Math.min(left, MAX_TIMER_MS),
		);
	};
	if (bounded) arm();
	callerSignal?.addEventListener("abort", onCallerAbort, { once: true });

	return {
		signal: controller.signal,
		remainingMs,
		source: () => {
			if (!source && remainingMs() === 0) trip("timeout");
			return source;
		},
		fired: () => fired,
		dispose: () => {
			clearTimeout(timer);
			callerSignal?.removeEventListener("abort", onCallerAbort);
		},
	};
}
