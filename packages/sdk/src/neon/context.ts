import type { Client } from "../client/client/index.js";
import { toNeonError } from "./errors.js";
import { err, type NeonResult, ok } from "./result.js";
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

	async run<D, T>(
		opts: CallOptions | undefined,
		exec: (client: Client) => Promise<RawResult<D>>,
		map: (data: D) => T,
	): Promise<T | NeonResult<T>> {
		const shouldThrow = opts?.throwOnError ?? this.#config.throwOnError;
		const result = await this.#execute(opts, exec, map);
		if (!shouldThrow) return result;
		if (result.error) throw result.error;
		return result.data;
	}

	async #execute<D, T>(
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

		const wait = opts?.waitForReadiness ?? this.#config.waitForReadiness;
		if (wait && hasOperations(raw.data)) {
			const waited = await waitForOperations(
				this.#config.client,
				raw.data.operations,
				{
					...this.#config.waitOptions,
					signal: opts?.signal ?? this.#config.waitOptions.signal,
				},
			);
			if (waited.error) return err(waited.error);
		}

		return ok(map(raw.data));
	}
}
