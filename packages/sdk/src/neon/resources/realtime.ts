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
import type { NeonResult, Outcome } from "../result.js";

export type RealtimeGetParams = { projectId: string; branchId: string };
export type RealtimeEnableParams = RealtimeGetParams & RealtimeOptions;
export type RealtimeDisableParams = RealtimeGetParams;
export type RealtimeSecretParams = RealtimeGetParams;
export type RealtimeRotateSecretParams = RealtimeGetParams;

const SELECTORS = { projectId: "string", branchId: "string" } as const;

/**
 * Branch-scoped Realtime. Enable, disable, and rotate are asynchronous and resolve once
 * the change is queued; poll {@link Realtime.get} until `pending` is `false`.
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
	 * Enable Realtime, or apply new options to a branch that already has it.
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
		const invalid = validateParams(params, "realtime.enable", SELECTORS);
		if (invalid) {
			return invalidParamsResult<void>(
				invalid,
				this.#ctx.shouldThrow(opts),
			);
		}
		const { projectId, branchId, ...input } = params;
		return this.#ctx.runVoid(opts, (client, signal) =>
			enableProjectBranchRealtime({
				client,
				path: { project_id: projectId, branch_id: branchId },
				body: input,
				throwOnError: false,
				signal,
			}),
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
		const invalid = validateParams(params, "realtime.disable", SELECTORS);
		if (invalid) {
			return invalidParamsResult<void>(
				invalid,
				this.#ctx.shouldThrow(opts),
			);
		}
		const { projectId, branchId } = params;
		return this.#ctx.runVoid(opts, (client, signal) =>
			disableProjectBranchRealtime({
				client,
				path: { project_id: projectId, branch_id: branchId },
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
		const invalid = validateParams(
			params,
			"realtime.rotateSecret",
			SELECTORS,
		);
		if (invalid) {
			return invalidParamsResult<void>(
				invalid,
				this.#ctx.shouldThrow(opts),
			);
		}
		const { projectId, branchId } = params;
		return this.#ctx.runVoid(opts, (client, signal) =>
			rotateProjectBranchRealtimeSecret({
				client,
				path: { project_id: projectId, branch_id: branchId },
				throwOnError: false,
				signal,
			}),
		);
	}
}
