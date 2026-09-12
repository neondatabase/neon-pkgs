import {
	createProjectBranch,
	deleteProjectBranch,
	finalizeRestoreBranch,
	getProjectBranch,
	getProjectBranchSchemaComparison,
	listProjectBranches,
	restoreProjectBranch,
	setDefaultProjectBranch,
	updateProjectBranch,
} from "../../client/sdk.gen.js";
import type {
	Branch,
	BranchCreateRequest,
	BranchSchemaCompareResponse,
	BranchUpdateRequest,
	Endpoint,
	ListProjectBranchesData,
} from "../../client/types.gen.js";
import { withConnectionString } from "../connection.js";
import type { CallOptions, RequestContext } from "../context.js";
import { NeonClientError } from "../errors.js";
import { type Paginated, paginate } from "../paginate.js";
import { invalidParamsResult, validateParams } from "../params.js";
import { err, finalize, type NeonResult, type Outcome, ok } from "../result.js";

type ListQuery = Omit<NonNullable<ListProjectBranchesData["query"]>, "cursor">;
type BranchFields = NonNullable<BranchCreateRequest["branch"]>;
type UpdateInput = BranchUpdateRequest["branch"];

export interface ComputeSettings {
	minCu?: number;
	maxCu?: number;
	suspendTimeoutSeconds?: number;
}

type CreateInputBase = BranchFields & {
	compute?: ComputeSettings;
};

export type CreateInput =
	| (CreateInputBase & { noCompute?: false })
	| (BranchFields & { noCompute: true; compute?: never });

export interface CreateAndConnectInput {
	name?: string;
	/** Parent branch id. Defaults to the project's default branch. */
	parentId?: string;
	compute?: ComputeSettings;
}

/** A branch with its read-write endpoint and a ready-to-use connection string. */
export interface BranchConnection {
	branch: Branch;
	endpoint: Endpoint;
	connectionString: string;
}

const NO_COMPUTE_WITH_COMPUTE = "Pass compute settings or noCompute, not both.";

const readWriteEndpoint = (compute?: ComputeSettings) => ({
	type: "read_write" as const,
	autoscaling_limit_min_cu: compute?.minCu,
	autoscaling_limit_max_cu: compute?.maxCu,
	suspend_timeout_seconds: compute?.suspendTimeoutSeconds,
});

export interface ResetFromParentInput {
	/** Required when the branch has children so they can move to the preserved branch. */
	preserveUnderName?: string;
}

export interface CompareSchemaInput {
	databaseName: string;
	baseBranchId?: string;
	lsn?: string;
	timestamp?: string;
	baseLsn?: string;
	baseTimestamp?: string;
}

export type BranchListParams = ListQuery & { projectId: string };
export interface BranchGetParams {
	projectId: string;
	branchId: string;
}
export type BranchCreateParams = CreateInput & { projectId: string };
export type BranchUpdateParams = UpdateInput & {
	projectId: string;
	branchId: string;
};
export interface BranchDeleteParams {
	projectId: string;
	branchId: string;
}
export type BranchCreateAndConnectParams = CreateAndConnectInput & {
	projectId: string;
	/** Return a pooled connection string (default `true`). */
	pooled?: boolean;
};
export interface BranchGetDefaultParams {
	projectId: string;
}
export interface BranchSetDefaultParams {
	projectId: string;
	branchId: string;
}
export type BranchResetFromParentParams = ResetFromParentInput & {
	projectId: string;
	branchId: string;
};
export type BranchCompareSchemaParams = CompareSchemaInput & {
	projectId: string;
	branchId: string;
};
export interface BranchFinalizeRestoreParams {
	projectId: string;
	branchId: string;
	name?: string;
}

export class Branches<DThrow extends boolean> {
	readonly #ctx: RequestContext;

	constructor(ctx: RequestContext) {
		this.#ctx = ctx;
	}

	/** @apiCall GET /projects/{project_id}/branches (cursor-paginated) */
	list(params: BranchListParams): Paginated<Branch, DThrow>;
	list<Throw extends boolean = DThrow>(
		params: BranchListParams,
		opts: CallOptions<Throw>,
	): Paginated<Branch, Throw>;
	list(
		params: BranchListParams,
		opts?: CallOptions,
	): Paginated<Branch, boolean> {
		const error = validateParams(params, "branches.list", {
			projectId: "string",
		});
		const { projectId, ...query } = error
			? ({} as BranchListParams)
			: params;
		return paginate(
			async (cursor, signal) => {
				if (error) throw error;
				return listProjectBranches({
					client: this.#ctx.client,
					path: { project_id: projectId },
					query: { ...query, cursor },
					throwOnError: false,
					signal,
				});
			},
			(data) => ({
				items: data?.branches ?? [],
				cursor: data?.pagination?.next,
			}),
			() => this.#ctx.deadlineFor(opts),
			this.#ctx.shouldThrow(opts),
		);
	}

	/** @apiCall GET /projects/{project_id}/branches/{branch_id} */
	get(params: BranchGetParams): Promise<Outcome<Branch, DThrow>>;
	get<Throw extends boolean = DThrow>(
		params: BranchGetParams,
		opts: CallOptions<Throw>,
	): Promise<Outcome<Branch, Throw>>;
	get(
		params: BranchGetParams,
		opts?: CallOptions,
	): Promise<Branch | NeonResult<Branch>> {
		const error = validateParams(params, "branches.get", {
			projectId: "string",
			branchId: "string",
		});
		if (error)
			return invalidParamsResult<Branch>(
				error,
				this.#ctx.shouldThrow(opts),
			);
		const { projectId, branchId } = params;
		return this.#ctx.run(
			opts,
			(client, signal) =>
				getProjectBranch({
					client,
					path: { project_id: projectId, branch_id: branchId },
					throwOnError: false,
					signal,
				}),
			(data) => data.branch,
		);
	}

	/**
	 * This method retains its branch-only result even when it provisions compute;
	 * use {@link Branches.createAndConnect} or `postgres.connectionString` when a
	 * connection string is needed.
	 *
	 * Readiness polling stays on for `noCompute` branches because a
	 * compute-less branch still has provisioning operations.
	 */
	create(params: BranchCreateParams): Promise<Outcome<Branch, DThrow>>;
	create<Throw extends boolean = DThrow>(
		params: BranchCreateParams,
		opts: CallOptions<Throw>,
	): Promise<Outcome<Branch, Throw>>;
	async create(
		params: BranchCreateParams,
		opts?: CallOptions,
	): Promise<Branch | NeonResult<Branch>> {
		const paramsError = validateParams(params, "branches.create", {
			projectId: "string",
		});
		if (paramsError)
			return invalidParamsResult<Branch>(
				paramsError,
				this.#ctx.shouldThrow(opts),
			);
		const { projectId, ...input } = params;
		const shouldThrow =
			opts?.throwOnError ?? this.#ctx.defaults.throwOnError;
		const parsed = parseCreateInput(input);
		if (parsed.error) {
			return finalize(err<Branch>(parsed.error), shouldThrow);
		}
		return this.#ctx.run(
			{
				...opts,
				waitForReadiness: this.#ctx.resolveWait(opts, true),
			},
			(client, signal) =>
				createProjectBranch({
					client,
					path: { project_id: projectId },
					body: {
						branch: parsed.branch,
						...(parsed.noCompute
							? {}
							: {
									endpoints: [
										readWriteEndpoint(parsed.compute),
									],
								}),
					},
					throwOnError: false,
					signal,
				}),
			(data) => data.branch,
		);
	}

	/** @apiCall PATCH /projects/{project_id}/branches/{branch_id} */
	update(params: BranchUpdateParams): Promise<Outcome<Branch, DThrow>>;
	update<Throw extends boolean = DThrow>(
		params: BranchUpdateParams,
		opts: CallOptions<Throw>,
	): Promise<Outcome<Branch, Throw>>;
	update(
		params: BranchUpdateParams,
		opts?: CallOptions,
	): Promise<Branch | NeonResult<Branch>> {
		const error = validateParams(params, "branches.update", {
			projectId: "string",
			branchId: "string",
		});
		if (error)
			return invalidParamsResult<Branch>(
				error,
				this.#ctx.shouldThrow(opts),
			);
		const { projectId, branchId, ...input } = params;
		return this.#ctx.run(
			opts,
			(client, signal) =>
				updateProjectBranch({
					client,
					path: { project_id: projectId, branch_id: branchId },
					body: { branch: input },
					throwOnError: false,
					signal,
				}),
			(data) => data.branch,
		);
	}

	/** @apiCall DELETE /projects/{project_id}/branches/{branch_id} */
	delete(params: BranchDeleteParams): Promise<Outcome<void, DThrow>>;
	delete<Throw extends boolean = DThrow>(
		params: BranchDeleteParams,
		opts: CallOptions<Throw>,
	): Promise<Outcome<void, Throw>>;
	delete(
		params: BranchDeleteParams,
		opts?: CallOptions,
	): Promise<void | NeonResult<void>> {
		const error = validateParams(params, "branches.delete", {
			projectId: "string",
			branchId: "string",
		});
		if (error)
			return invalidParamsResult<void>(
				error,
				this.#ctx.shouldThrow(opts),
			);
		const { projectId, branchId } = params;
		return this.#ctx.runVoid(opts, (client, signal) =>
			deleteProjectBranch({
				client,
				path: { project_id: projectId, branch_id: branchId },
				throwOnError: false,
				signal,
			}),
		);
	}

	createAndConnect(
		params: BranchCreateAndConnectParams,
	): Promise<Outcome<BranchConnection, DThrow>>;
	createAndConnect<Throw extends boolean = DThrow>(
		params: BranchCreateAndConnectParams,
		opts: CallOptions<Throw>,
	): Promise<Outcome<BranchConnection, Throw>>;
	async createAndConnect(
		params: BranchCreateAndConnectParams,
		opts?: CallOptions<boolean>,
	): Promise<BranchConnection | NeonResult<BranchConnection>> {
		const error = validateParams(params, "branches.createAndConnect", {
			projectId: "string",
		});
		if (error)
			return invalidParamsResult<BranchConnection>(
				error,
				this.#ctx.shouldThrow(opts),
			);
		const { projectId, pooled = true, name, parentId, compute } = params;
		const shouldThrow =
			opts?.throwOnError ?? this.#ctx.defaults.throwOnError;
		const result = await this.#ctx.execute(
			{ ...opts, waitForReadiness: this.#ctx.resolveWait(opts, true) },
			(client, signal) =>
				createProjectBranch({
					client,
					path: { project_id: projectId },
					body: {
						branch: {
							name,
							parent_id: parentId,
						},
						endpoints: [readWriteEndpoint(compute)],
					},
					throwOnError: false,
					signal,
				}),
			(data) => data,
		);
		const out = withConnectionString(
			result,
			(data) => data.connection_uris,
			(data, connectionString) => ({
				branch: data.branch,
				endpoint: data.endpoints[0],
				connectionString,
			}),
			pooled,
		);
		return finalize(out, shouldThrow);
	}

	/**
	 * Resolve the project's default branch (by the `default` flag — not by name).
	 * Returns a {@link NeonClientError} when no default branch is found.
	 */
	getDefault(
		params: BranchGetDefaultParams,
	): Promise<Outcome<Branch, DThrow>>;
	getDefault<Throw extends boolean = DThrow>(
		params: BranchGetDefaultParams,
		opts: CallOptions<Throw>,
	): Promise<Outcome<Branch, Throw>>;
	async getDefault(
		params: BranchGetDefaultParams,
		opts?: CallOptions,
	): Promise<Branch | NeonResult<Branch>> {
		const error = validateParams(params, "branches.getDefault", {
			projectId: "string",
		});
		if (error)
			return invalidParamsResult<Branch>(
				error,
				this.#ctx.shouldThrow(opts),
			);
		const { projectId } = params;
		const shouldThrow =
			opts?.throwOnError ?? this.#ctx.defaults.throwOnError;
		const result = await this.#ctx.execute(
			opts,
			(client, signal) =>
				listProjectBranches({
					client,
					path: { project_id: projectId },
					throwOnError: false,
					signal,
				}),
			(data) => data.branches,
		);
		if (result.error)
			return finalize(err<Branch>(result.error), shouldThrow);
		const branch = result.data.find((candidate) => candidate.default);
		if (!branch) {
			return finalize(
				err<Branch>(
					new NeonClientError(
						"No default branch found for the project.",
					),
				),
				shouldThrow,
			);
		}
		return finalize(ok(branch), shouldThrow);
	}

	/** @apiCall POST /projects/{project_id}/branches/{branch_id}/set_as_default */
	setDefault(
		params: BranchSetDefaultParams,
	): Promise<Outcome<Branch, DThrow>>;
	setDefault<Throw extends boolean = DThrow>(
		params: BranchSetDefaultParams,
		opts: CallOptions<Throw>,
	): Promise<Outcome<Branch, Throw>>;
	setDefault(
		params: BranchSetDefaultParams,
		opts?: CallOptions,
	): Promise<Branch | NeonResult<Branch>> {
		const error = validateParams(params, "branches.setDefault", {
			projectId: "string",
			branchId: "string",
		});
		if (error)
			return invalidParamsResult<Branch>(
				error,
				this.#ctx.shouldThrow(opts),
			);
		const { projectId, branchId } = params;
		return this.#ctx.run(
			opts,
			(client, signal) =>
				setDefaultProjectBranch({
					client,
					path: { project_id: projectId, branch_id: branchId },
					throwOnError: false,
					signal,
				}),
			(data) => data.branch,
		);
	}

	/**
	 * Uses the parent's current HEAD; use raw `restoreProjectBranch` for an LSN or timestamp.
	 *
	 * @apiCall GET /projects/{project_id}/branches/{branch_id}
	 * @apiCall POST /projects/{project_id}/branches/{branch_id}/restore
	 */
	resetFromParent(
		params: BranchResetFromParentParams,
	): Promise<Outcome<Branch, DThrow>>;
	resetFromParent<Throw extends boolean = DThrow>(
		params: BranchResetFromParentParams,
		opts: CallOptions<Throw>,
	): Promise<Outcome<Branch, Throw>>;
	async resetFromParent(
		params: BranchResetFromParentParams,
		opts?: CallOptions,
	): Promise<Branch | NeonResult<Branch>> {
		const error = validateParams(params, "branches.resetFromParent", {
			projectId: "string",
			branchId: "string",
		});
		if (error)
			return invalidParamsResult<Branch>(
				error,
				this.#ctx.shouldThrow(opts),
			);
		const { projectId, branchId, preserveUnderName } = params;
		const shouldThrow =
			opts?.throwOnError ?? this.#ctx.defaults.throwOnError;
		const current = await this.#ctx.execute(
			opts,
			(client, signal) =>
				getProjectBranch({
					client,
					path: { project_id: projectId, branch_id: branchId },
					throwOnError: false,
					signal,
				}),
			(data) => data.branch,
		);
		if (current.error) {
			return finalize(err<Branch>(current.error), shouldThrow);
		}
		const parentId = current.data.parent_id;
		if (!parentId) {
			return finalize(
				err<Branch>(
					new NeonClientError(
						"Branch has no parent and cannot be reset.",
					),
				),
				shouldThrow,
			);
		}
		return this.#ctx.run(
			opts,
			(client, signal) =>
				restoreProjectBranch({
					client,
					path: { project_id: projectId, branch_id: branchId },
					body: {
						source_branch_id: parentId,
						...(preserveUnderName === undefined
							? {}
							: { preserve_under_name: preserveUnderName }),
					},
					throwOnError: false,
					signal,
				}),
			(data) => data.branch,
		);
	}

	/**
	 * Returns a unified SQL diff; omitting `baseBranchId` uses the parent branch.
	 *
	 * @apiCall GET /projects/{project_id}/branches/{branch_id}/compare_schema
	 */
	compareSchema(
		params: BranchCompareSchemaParams,
	): Promise<Outcome<BranchSchemaCompareResponse, DThrow>>;
	compareSchema<Throw extends boolean = DThrow>(
		params: BranchCompareSchemaParams,
		opts: CallOptions<Throw>,
	): Promise<Outcome<BranchSchemaCompareResponse, Throw>>;
	compareSchema(
		params: BranchCompareSchemaParams,
		opts?: CallOptions,
	): Promise<
		BranchSchemaCompareResponse | NeonResult<BranchSchemaCompareResponse>
	> {
		const error = validateParams(params, "branches.compareSchema", {
			projectId: "string",
			branchId: "string",
			databaseName: "string",
		});
		if (error)
			return invalidParamsResult<BranchSchemaCompareResponse>(
				error,
				this.#ctx.shouldThrow(opts),
			);
		const {
			projectId,
			branchId,
			databaseName,
			baseBranchId,
			lsn,
			timestamp,
			baseLsn,
			baseTimestamp,
		} = params;
		return this.#ctx.run(
			opts,
			(client, signal) =>
				getProjectBranchSchemaComparison({
					client,
					path: { project_id: projectId, branch_id: branchId },
					query: {
						db_name: databaseName,
						...(baseBranchId === undefined
							? {}
							: { base_branch_id: baseBranchId }),
						...(lsn === undefined ? {} : { lsn }),
						...(timestamp === undefined ? {} : { timestamp }),
						...(baseLsn === undefined ? {} : { base_lsn: baseLsn }),
						...(baseTimestamp === undefined
							? {}
							: { base_timestamp: baseTimestamp }),
					},
					throwOnError: false,
					signal,
				}),
			(data) => data,
		);
	}

	/**
	 * Complete (commit) a restore previously started with `snapshots.restore({ finalize: false })`:
	 * moves computes onto the restored branch and renames the replaced one. This is **only**
	 * the second step — it does not restore anything itself.
	 *
	 * @apiCall POST /projects/{project_id}/branches/{branch_id}/restore/finalize
	 */
	finalizeRestore(
		params: BranchFinalizeRestoreParams,
	): Promise<Outcome<void, DThrow>>;
	finalizeRestore<Throw extends boolean = DThrow>(
		params: BranchFinalizeRestoreParams,
		opts: CallOptions<Throw>,
	): Promise<Outcome<void, Throw>>;
	finalizeRestore(
		params: BranchFinalizeRestoreParams,
		opts?: CallOptions,
	): Promise<void | NeonResult<void>> {
		const error = validateParams(params, "branches.finalizeRestore", {
			projectId: "string",
			branchId: "string",
		});
		if (error)
			return invalidParamsResult<void>(
				error,
				this.#ctx.shouldThrow(opts),
			);
		const { projectId, branchId, name } = params;
		return this.#ctx.run(
			opts,
			(client, signal) =>
				finalizeRestoreBranch({
					client,
					path: { project_id: projectId, branch_id: branchId },
					body: { name },
					throwOnError: false,
					signal,
				}),
			() => undefined,
		);
	}
}

function parseCreateInput(input?: CreateInput):
	| {
			error: NeonClientError;
	  }
	| {
			error?: undefined;
			branch: BranchFields;
			noCompute: boolean;
			compute?: ComputeSettings;
	  } {
	if (input === undefined) {
		return { branch: {}, noCompute: false };
	}
	if (input.noCompute === true) {
		if ("compute" in input && input.compute !== undefined) {
			return {
				error: new NeonClientError(NO_COMPUTE_WITH_COMPUTE),
			};
		}
		const { noCompute: _noCompute, compute: _compute, ...branch } = input;
		return { branch, noCompute: true };
	}
	const { noCompute: _noCompute, compute, ...branch } = input;
	return { branch, noCompute: false, compute };
}
