import {
	monotonicNow,
	type ReconnectTimer,
	setDeadlineTimer,
} from "./timer.js";

export type { ReconnectTimer } from "./timer.js";

export const DEFAULT_RECONNECT_BASE_MS = 1_000;
export const DEFAULT_RECONNECT_CAP_MS = 60_000;
export const DEFAULT_RECONNECT_STABILITY_MS = 30_000;
export const DEFAULT_RECONNECT_MAX_ATTEMPTS = 20;
export const DEFAULT_RECONNECT_MAX_ELAPSED_MS = 15 * 60_000;
export const DEFAULT_OVERLOAD_JITTER_CAP_MS = 30_000;

export interface ReconnectOptions {
	readonly baseMs?: number;
	readonly capMs?: number;
	readonly stabilityMs?: number;
	/**
	 * Reconnect indefinitely. This is the default when no explicit attempt or
	 * elapsed-time bound is configured.
	 */
	readonly unbounded?: boolean;
	readonly maxAttempts?: number;
	readonly maxElapsedMs?: number;
	/**
	 * Maximum jitter ceiling for `backend_overloaded` hint-paced retries.
	 * Applied as the cap in [hint, min(2*hint, overloadJitterCapMs)].
	 * Default: 30 seconds.
	 */
	readonly overloadJitterCapMs?: number;
	readonly random?: () => number;
	readonly now?: () => number;
	readonly setTimer?: (callback: () => void, delayMs: number) => unknown;
	readonly clearTimer?: (handle: unknown) => void;
}

export interface ReconnectAttempt {
	/** One-based attempt number within the current reconnect episode. */
	readonly attempt: number;
	readonly delayMs: number;
	readonly remainingMs: number;
}

/** Owns one equal-jitter backoff episode with optional safety bounds. */
export class ReconnectBackoff {
	readonly stabilityMs: number;
	private readonly baseMs: number;
	private readonly capMs: number;
	private readonly maxAttempts: number;
	private readonly maxElapsedMs: number;
	private readonly unbounded: boolean;
	private readonly overloadJitterCapMs: number;
	private readonly random: () => number;
	private readonly now: () => number;
	private readonly setTimerImpl: (
		callback: () => void,
		delayMs: number,
	) => ReconnectTimer;
	private attempt = 0;
	private exponent = 0;
	private startedAt?: number;

	constructor(options: ReconnectOptions = {}) {
		this.baseMs = positiveSafeInteger(
			options.baseMs ?? DEFAULT_RECONNECT_BASE_MS,
			"reconnect.baseMs",
		);
		this.capMs = positiveSafeInteger(
			options.capMs ?? DEFAULT_RECONNECT_CAP_MS,
			"reconnect.capMs",
		);
		if (this.baseMs > this.capMs) {
			throw new RangeError(
				"reconnect.baseMs must not exceed reconnect.capMs",
			);
		}
		this.stabilityMs = positiveSafeInteger(
			options.stabilityMs ?? DEFAULT_RECONNECT_STABILITY_MS,
			"reconnect.stabilityMs",
		);
		this.unbounded =
			options.unbounded ??
			(options.maxAttempts === undefined &&
				options.maxElapsedMs === undefined);
		this.maxAttempts = positiveSafeInteger(
			options.maxAttempts ?? DEFAULT_RECONNECT_MAX_ATTEMPTS,
			"reconnect.maxAttempts",
		);
		this.maxElapsedMs = positiveSafeInteger(
			options.maxElapsedMs ?? DEFAULT_RECONNECT_MAX_ELAPSED_MS,
			"reconnect.maxElapsedMs",
		);
		this.overloadJitterCapMs = positiveSafeInteger(
			options.overloadJitterCapMs ?? DEFAULT_OVERLOAD_JITTER_CAP_MS,
			"reconnect.overloadJitterCapMs",
		);

		const configuredRandom = options.random ?? Math.random;
		let firstRandom: number | undefined = unitInterval(
			configuredRandom(),
			"reconnect.random",
		);
		this.random = () => {
			if (firstRandom !== undefined) {
				const value = firstRandom;
				firstRandom = undefined;
				return value;
			}
			return unitInterval(configuredRandom(), "reconnect.random");
		};

		const configuredNow = options.now ?? monotonicNow;
		let lastNow = nonnegativeFinite(configuredNow(), "reconnect.now");
		this.now = () => {
			const sampled = nonnegativeFinite(configuredNow(), "reconnect.now");
			// Clock rollback must not extend an already-running reconnect episode.
			lastNow = Math.max(lastNow, sampled);
			return lastNow;
		};
		const clearTimer =
			options.clearTimer ??
			((handle: unknown) =>
				clearTimeout(handle as ReturnType<typeof setTimeout>));
		this.setTimerImpl = (callback, delayMs) => {
			if (!options.setTimer)
				return setDeadlineTimer(callback, delayMs, clearTimer);
			let active = true;
			const handle = options.setTimer(() => {
				if (!active) return;
				active = false;
				callback();
			}, delayMs);
			return () => {
				if (!active) return;
				active = false;
				clearTimer(handle);
			};
		};
	}

	get active(): boolean {
		return this.startedAt !== undefined;
	}

	next(retryAfterMs?: number): ReconnectAttempt | undefined {
		const now = this.now();
		this.startedAt ??= now;
		const elapsedMs = now - this.startedAt;
		if (
			!this.unbounded &&
			(this.attempt >= this.maxAttempts || elapsedMs >= this.maxElapsedMs)
		) {
			return undefined;
		}
		const remainingMs = this.unbounded
			? Number.POSITIVE_INFINITY
			: this.maxElapsedMs - elapsedMs;
		let delayMs: number;
		if (retryAfterMs === undefined) {
			delayMs = Math.min(
				equalJitterDelayMs(
					this.exponent,
					this.baseMs,
					this.capMs,
					this.random,
				),
				remainingMs,
			);
			this.exponent += 1;
		} else {
			const hint = Math.max(retryAfterMs, 100);
			const ceiling = Math.max(
				hint,
				Math.min(2 * hint, this.overloadJitterCapMs),
			);
			delayMs = hint + this.random() * (ceiling - hint);
		}
		this.attempt += 1;
		return Object.freeze({
			attempt: this.attempt,
			delayMs,
			remainingMs,
		});
	}

	reset(): void {
		this.attempt = 0;
		this.exponent = 0;
		this.startedAt = undefined;
	}

	setTimer(callback: () => void, delayMs: number): ReconnectTimer {
		return this.setTimerImpl(callback, delayMs);
	}

	clearTimer(handle: ReconnectTimer): void {
		handle();
	}
}

/** Returns a delay in [half the capped exponential delay, the full delay). */
export function equalJitterDelayMs(
	attempt: number,
	baseMs: number,
	capMs: number,
	random: () => number,
): number {
	const capped = Math.min(capMs, baseMs * 2 ** attempt);
	const half = capped / 2;
	return half + unitInterval(random(), "reconnect.random") * half;
}

function positiveSafeInteger(value: number, name: string): number {
	if (!Number.isSafeInteger(value) || value <= 0) {
		throw new RangeError(`${name} must be a positive safe integer`);
	}
	return value;
}

function unitInterval(value: number, name: string): number {
	if (!Number.isFinite(value) || value < 0 || value >= 1) {
		throw new RangeError(`${name} must return a finite number in [0, 1)`);
	}
	return value;
}

function nonnegativeFinite(value: number, name: string): number {
	if (!Number.isFinite(value) || value < 0) {
		throw new RangeError(
			`${name} must return a non-negative finite number`,
		);
	}
	return value;
}
