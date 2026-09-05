import type { Client } from "../client/client/index.js";
import {
	cancelled,
	createDeadline,
	type Deadline,
	resolveTimeoutMs,
	runBounded,
} from "./deadline.js";
import { type NeonError, toNeonError } from "./errors.js";
import { err, finalize, type NeonResult, ok } from "./result.js";
import { withRetries } from "./retry.js";
import { hasOperations, type WaitBudget, waitForOperations } from "./wait.js";

/** Fully-resolved runtime configuration shared by every resource namespace. */
export interface ResolvedConfig {
	client: Client;
	throwOnError: boolean;
	retries: number;
	/** `Infinity` when calls are unbounded, which is the default. */
	requestTimeoutMs: number;
	waitForReadiness: boolean;
	waitOptions: WaitBudget;
	orgId?: string;
}

/** Per-call overrides accepted by every ergonomic method. */
export interface CallOptions<Throw extends boolean = boolean> {
	/** Override the client's `throwOnError` for this call. */
	throwOnError?: Throw;
	/** Override the client's `waitForReadiness` for this call (mutations only). */
	waitForReadiness?: boolean;
	/**
	 * Deadline for this request and its retries. `Infinity` opts out of a client-wide
	 * value; readiness polling keeps its own `wait` budget either way.
	 */
	requestTimeoutMs?: number;
	/**
	 * Override the client's `wait` budget for this call's readiness polling.
	 * Does not turn polling on; pair it with `waitForReadiness` when the method
	 * would not wait otherwise.
	 */
	wait?: WaitBudget;
	/** Cancel the call. Surfaces as a `NeonAbortError` (`kind: "aborted"`). */
	signal?: AbortSignal;
}

interface RawResult<D> {
	data?: D | undefined;
	error?: unknown;
	response?: Response | undefined;
}

/** Every generated call the ergonomic layer makes, given the client and the call's signal. */
type Exec<D> = (
	client: Client,
	signal: AbortSignal | undefined,
) => Promise<RawResult<D>>;

/** The request phase's outcome, before readiness polling is considered. */
type Requested<D> =
	| { ok: true; data: D | undefined; response: Response | undefined }
	| { ok: false; error: NeonError };

/**
 * Shared execution core: runs a raw client call under a deadline and with retries, maps
 * its envelope to the ergonomic resource shape, optionally waits for provisioning
 * operations, and applies the resolved `throwOnError` policy. Returns the bare value
 * (throwing) or a {@link NeonResult}.
 */
export class RequestContext {
	readonly #config: ResolvedConfig;

	constructor(config: ResolvedConfig) {
		this.#config = config;
	}

	get client(): Client {
		return this.#config.client;
	}

	get defaults(): ResolvedConfig {
		return this.#config;
	}

	/**
	 * The deadline for one call: the per-call timeout if given, else the client's.
	 *
	 * A per-call value is validated the same way the client's was. Skipping that left
	 * `requestTimeoutMs: NaN` meaning *unbounded* and a value past `setTimeout`'s range
	 * meaning *1ms*, both silently.
	 */
	deadlineFor(opts: CallOptions | undefined): Deadline {
		const timeoutMs =
			opts?.requestTimeoutMs === undefined
				? this.#config.requestTimeoutMs
				: resolveTimeoutMs(opts.requestTimeoutMs);
		return createDeadline(timeoutMs, opts?.signal);
	}

	/** Run a raw call and map its body; applies the resolved `throwOnError` policy. */
	async run<D, T>(
		opts: CallOptions | undefined,
		exec: Exec<D>,
		map: (data: D) => T,
	): Promise<T | NeonResult<T>> {
		const shouldThrow = opts?.throwOnError ?? this.#config.throwOnError;
		return finalize(await this.execute(opts, exec, map), shouldThrow);
	}

	/** Like {@link run} but for endpoints that may return an empty (204) body. */
	async runVoid<D>(
		opts: CallOptions | undefined,
		exec: Exec<D>,
	): Promise<void | NeonResult<void>> {
		const shouldThrow = opts?.throwOnError ?? this.#config.throwOnError;
		const requested = await this.#request(opts, exec);
		if (!requested.ok)
			return finalize(err<void>(requested.error), shouldThrow);
		const readiness = await this.#maybeWait(opts, requested.data);
		if (readiness?.error) {
			return finalize(err<void>(readiness.error), shouldThrow);
		}
		return finalize(ok(undefined), shouldThrow);
	}

	/**
	 * Run a raw call and map its body, returning the {@link NeonResult} envelope (no
	 * throw). Used by `run` and by workflows that post-process the result.
	 */
	async execute<D, T>(
		opts: CallOptions | undefined,
		exec: Exec<D>,
		map: (data: D) => T,
	): Promise<NeonResult<T>> {
		const requested = await this.#request(opts, exec);
		if (!requested.ok) return err(requested.error);
		if (requested.data === undefined) {
			return err(toNeonError(undefined, requested.response));
		}
		const readiness = await this.#maybeWait(opts, requested.data);
		if (readiness?.error) return err(readiness.error);
		return ok(map(requested.data));
	}

	/**
	 * The request phase: bounded by the call's deadline, retried, and never allowed to
	 * reject. The deadline is disposed before readiness polling begins, so a request
	 * budget cannot cut short the separate `wait` budget.
	 */
	async #request<D>(
		opts: CallOptions | undefined,
		exec: Exec<D>,
	): Promise<Requested<D>> {
		const deadline = this.deadlineFor(opts);
		try {
			const raw = await runBounded(deadline, () =>
				withRetries(
					() => exec(this.#config.client, deadline.signal),
					this.#config.retries,
					deadline,
				),
			);
			const cancellation = cancelled(deadline);
			if (cancellation) return { ok: false, error: cancellation };
			if (raw === undefined) {
				return { ok: false, error: toNeonError(undefined, undefined) };
			}
			if (raw.error !== undefined) {
				return {
					ok: false,
					error: toNeonError(raw.error, raw.response),
				};
			}
			return { ok: true, data: raw.data, response: raw.response };
		} catch (error) {
			return {
				ok: false,
				error: cancelled(deadline) ?? toNeonError(error, undefined),
			};
		} finally {
			deadline.dispose();
		}
	}

	/** Poll provisioning operations when `waitForReadiness` is on and the body has any. */
	async #maybeWait(
		opts: CallOptions | undefined,
		data: unknown,
	): Promise<NeonResult<void> | undefined> {
		const wait = opts?.waitForReadiness ?? this.#config.waitForReadiness;
		if (!wait || !hasOperations(data)) return undefined;
		return waitForOperations(this.#config.client, data.operations, {
			pollIntervalMs:
				opts?.wait?.pollIntervalMs ??
				this.#config.waitOptions.pollIntervalMs,
			timeoutMs:
				opts?.wait?.timeoutMs ?? this.#config.waitOptions.timeoutMs,
			signal: opts?.signal,
		});
	}
}
