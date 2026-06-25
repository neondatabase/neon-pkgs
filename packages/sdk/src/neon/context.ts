import type { Client } from "../client/client/index.js";
import { toNeonError } from "./errors.js";
import { err, finalize, type NeonResult, ok } from "./result.js";
import { withRetries } from "./retry.js";
import {
	hasOperations,
	type WaitForOptions,
	waitForOperations,
} from "./wait.js";

/** Fully-resolved runtime configuration shared by every resource namespace. */
export interface ResolvedConfig {
	client: Client;
	throwOnError: boolean;
	retries: number;
	waitForReadiness: boolean;
	waitOptions: WaitForOptions;
	orgId?: string;
}

/** Per-call overrides accepted by every ergonomic method. */
export interface CallOptions<Throw extends boolean = boolean> {
	/** Override the client's `throwOnError` for this call. */
	throwOnError?: Throw;
	/** Override the client's `waitForReadiness` for this call (mutations only). */
	waitForReadiness?: boolean;
	signal?: AbortSignal;
}

interface RawResult<D> {
	data?: D | undefined;
	error?: unknown;
	response?: Response | undefined;
}

/**
 * Shared execution core: runs a raw client call with retries, maps its envelope to the
 * ergonomic resource shape, optionally waits for provisioning operations, and applies the
 * resolved `throwOnError` policy. Returns the bare value (throwing) or a {@link NeonResult}.
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

	/** Run a raw call and map its body; applies the resolved `throwOnError` policy. */
	async run<D, T>(
		opts: CallOptions | undefined,
		exec: (client: Client) => Promise<RawResult<D>>,
		map: (data: D) => T,
	): Promise<T | NeonResult<T>> {
		const shouldThrow = opts?.throwOnError ?? this.#config.throwOnError;
		return finalize(await this.execute(opts, exec, map), shouldThrow);
	}

	/** Like {@link run} but for endpoints that may return an empty (204) body. */
	async runVoid<D>(
		opts: CallOptions | undefined,
		exec: (client: Client) => Promise<RawResult<D>>,
	): Promise<void | NeonResult<void>> {
		const shouldThrow = opts?.throwOnError ?? this.#config.throwOnError;
		const raw = await withRetries(
			() => exec(this.#config.client),
			this.#config.retries,
			opts?.signal,
		);
		if (raw.error !== undefined) {
			return finalize(
				err<void>(toNeonError(raw.error, raw.response)),
				shouldThrow,
			);
		}
		const readiness = await this.#maybeWait(opts, raw.data);
		if (readiness?.error)
			return finalize(err<void>(readiness.error), shouldThrow);
		return finalize(ok(undefined), shouldThrow);
	}

	/**
	 * Run a raw call and map its body, returning the {@link NeonResult} envelope (no
	 * throw). Used by `run` and by workflows that post-process the result.
	 */
	async execute<D, T>(
		opts: CallOptions | undefined,
		exec: (client: Client) => Promise<RawResult<D>>,
		map: (data: D) => T,
	): Promise<NeonResult<T>> {
		const raw = await withRetries(
			() => exec(this.#config.client),
			this.#config.retries,
			opts?.signal,
		);
		if (raw.error || raw.data === undefined) {
			return err(toNeonError(raw.error, raw.response));
		}
		const readiness = await this.#maybeWait(opts, raw.data);
		if (readiness?.error) return err(readiness.error);
		return ok(map(raw.data));
	}

	/** Poll provisioning operations when `waitForReadiness` is on and the body has any. */
	async #maybeWait(
		opts: CallOptions | undefined,
		data: unknown,
	): Promise<NeonResult<void> | undefined> {
		const wait = opts?.waitForReadiness ?? this.#config.waitForReadiness;
		if (!wait || !hasOperations(data)) return undefined;
		return waitForOperations(this.#config.client, data.operations, {
			...this.#config.waitOptions,
			signal: opts?.signal ?? this.#config.waitOptions.signal,
		});
	}
}
