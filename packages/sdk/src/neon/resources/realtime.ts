import type { Client } from "../../client/client/index.js";
import {
	disableProjectBranchRealtime,
	enableProjectBranchRealtime,
	getProjectBranchRealtime,
	getProjectBranchRealtimeSecret,
	rotateProjectBranchRealtimeSecret,
} from "../../client/sdk.gen.js";
import type {
	RealtimeOptions,
	RealtimeSecret,
	Realtime as RealtimeState,
} from "../../client/types.gen.js";
import type { CallOptions, RequestContext } from "../context.js";
import { invalidParamsResult, validateParams } from "../params.js";
import { err, finalize, type NeonResult, type Outcome, ok } from "../result.js";
import { pollUntil } from "../wait.js";

export type RealtimeGetParams = { projectId: string; branchId: string };
export type RealtimeEnableParams = RealtimeGetParams & RealtimeOptions;
export type RealtimeDisableParams = RealtimeGetParams;
export type RealtimeSecretParams = RealtimeGetParams;
export type RealtimeRotateSecretParams = RealtimeGetParams;

const SELECTORS = { projectId: "string", branchId: "string" } as const;

type Path = { project_id: string; branch_id: string };
type Queue = (
	client: Client,
	path: Path,
	signal: AbortSignal | undefined,
) => Promise<{ error?: unknown; response?: Response }>;

/**
 * Branch-scoped Realtime. Enable, disable, and rotate are asynchronous: with
 * `waitForReadiness` they poll {@link Realtime.get} until `pending` is `false`, otherwise
 * they resolve once the API has queued the change.
 */
export class Realtime<DThrow extends boolean> {
	readonly #ctx: RequestContext;

	constructor(ctx: RequestContext) {
		this.#ctx = ctx;
	}

	/** @apiCall GET /projects/{project_id}/branches/{branch_id}/realtime */
	get(params: RealtimeGetParams): Promise<Outcome<RealtimeState, DThrow>>;
	get<Throw extends boolean = DThrow>(
		params: RealtimeGetParams,
		opts: CallOptions<Throw>,
	): Promise<Outcome<RealtimeState, Throw>>;
	get(
		params: RealtimeGetParams,
		opts?: CallOptions,
	): Promise<RealtimeState | NeonResult<RealtimeState>> {
		const invalid = validateParams(params, "realtime.get", SELECTORS);
		if (invalid) {
			return invalidParamsResult<RealtimeState>(
				invalid,
				this.#ctx.shouldThrow(opts),
			);
		}
		const { projectId, branchId } = params;
		return this.#ctx.run(
			opts,
			(client, signal) =>
				getProjectBranchRealtime({
					client,
					path: { project_id: projectId, branch_id: branchId },
					throwOnError: false,
					signal,
				}),
			(data) => data,
		);
	}

	/**
	 * Enable Realtime, or apply new options to a branch that already has it. Waits until
	 * the change is applied unless `waitForReadiness` is `false`.
	 *
	 * @apiCall POST /projects/{project_id}/branches/{branch_id}/realtime
	 */
	enable(params: RealtimeEnableParams): Promise<Outcome<void, DThrow>>;
	enable<Throw extends boolean = DThrow>(
		params: RealtimeEnableParams,
		opts: CallOptions<Throw>,
	): Promise<Outcome<void, Throw>>;
	enable(
		params: RealtimeEnableParams,
		opts?: CallOptions,
	): Promise<void | NeonResult<void>> {
		return this.#mutate(
			"realtime.enable",
			params,
			opts,
			true,
			(client, path, signal) => {
				const {
					projectId: _projectId,
					branchId: _branchId,
					...input
				} = params;
				return enableProjectBranchRealtime({
					client,
					path,
					body: input,
					throwOnError: false,
					signal,
				});
			},
		);
	}

	/**
	 * Disable Realtime and discard the branch's shared secret.
	 *
	 * @apiCall DELETE /projects/{project_id}/branches/{branch_id}/realtime
	 */
	disable(params: RealtimeDisableParams): Promise<Outcome<void, DThrow>>;
	disable<Throw extends boolean = DThrow>(
		params: RealtimeDisableParams,
		opts: CallOptions<Throw>,
	): Promise<Outcome<void, Throw>>;
	disable(
		params: RealtimeDisableParams,
		opts?: CallOptions,
	): Promise<void | NeonResult<void>> {
		return this.#mutate(
			"realtime.disable",
			params,
			opts,
			false,
			(client, path, signal) =>
				disableProjectBranchRealtime({
					client,
					path,
					throwOnError: false,
					signal,
				}),
		);
	}

	/**
	 * Read the server-only secret the application backend seals Realtime queries with.
	 *
	 * @apiCall GET /projects/{project_id}/branches/{branch_id}/realtime/secret
	 */
	secret(
		params: RealtimeSecretParams,
	): Promise<Outcome<RealtimeSecret, DThrow>>;
	secret<Throw extends boolean = DThrow>(
		params: RealtimeSecretParams,
		opts: CallOptions<Throw>,
	): Promise<Outcome<RealtimeSecret, Throw>>;
	secret(
		params: RealtimeSecretParams,
		opts?: CallOptions,
	): Promise<RealtimeSecret | NeonResult<RealtimeSecret>> {
		const invalid = validateParams(params, "realtime.secret", SELECTORS);
		if (invalid) {
			return invalidParamsResult<RealtimeSecret>(
				invalid,
				this.#ctx.shouldThrow(opts),
			);
		}
		const { projectId, branchId } = params;
		return this.#ctx.run(
			opts,
			(client, signal) =>
				getProjectBranchRealtimeSecret({
					client,
					path: { project_id: projectId, branch_id: branchId },
					throwOnError: false,
					signal,
				}),
			(data) => data,
		);
	}

	/**
	 * Replace the shared secret. `secret()` returns the new value once `pending` is `false`.
	 *
	 * @apiCall POST /projects/{project_id}/branches/{branch_id}/realtime/rotate_secret
	 */
	rotateSecret(
		params: RealtimeRotateSecretParams,
	): Promise<Outcome<void, DThrow>>;
	rotateSecret<Throw extends boolean = DThrow>(
		params: RealtimeRotateSecretParams,
		opts: CallOptions<Throw>,
	): Promise<Outcome<void, Throw>>;
	rotateSecret(
		params: RealtimeRotateSecretParams,
		opts?: CallOptions,
	): Promise<void | NeonResult<void>> {
		return this.#mutate(
			"realtime.rotateSecret",
			params,
			opts,
			false,
			(client, path, signal) =>
				rotateProjectBranchRealtimeSecret({
					client,
					path,
					throwOnError: false,
					signal,
				}),
		);
	}

	async #mutate(
		method: string,
		params: RealtimeGetParams,
		opts: CallOptions | undefined,
		waitByDefault: boolean,
		queue: Queue,
	): Promise<void | NeonResult<void>> {
		const shouldThrow = this.#ctx.shouldThrow(opts);
		const invalid = validateParams(params, method, SELECTORS);
		if (invalid) return invalidParamsResult<void>(invalid, shouldThrow);
		const path = {
			project_id: params.projectId,
			branch_id: params.branchId,
		};
		const queued = await this.#ctx.executeVoid(opts, (client, signal) =>
			queue(client, path, signal),
		);
		if (queued.error || !this.#ctx.resolveWait(opts, waitByDefault)) {
			return finalize(queued, shouldThrow);
		}
		const defaults = this.#ctx.defaults.waitOptions;
		const applied = await pollUntil(
			(signal) =>
				getProjectBranchRealtime({
					client: this.#ctx.client,
					path,
					throwOnError: false,
					signal,
				}),
			(state) => !state.pending,
			`Realtime on branch ${params.branchId} to apply the change`,
			{
				pollIntervalMs:
					opts?.wait?.pollIntervalMs ?? defaults.pollIntervalMs,
				timeoutMs: opts?.wait?.timeoutMs ?? defaults.timeoutMs,
				signal: opts?.signal,
			},
		);
		return finalize(
			applied.error ? err<void>(applied.error) : ok(undefined),
			shouldThrow,
		);
	}
}
