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
import { NeonError } from "../errors.js";
import { type Paginated, paginate } from "../paginate.js";
import { err, finalize, type NeonResult, type Outcome, ok } from "../result.js";

type ListQuery = Omit<NonNullable<ListProjectBranchesData["query"]>, "cursor">;
type BranchFields = NonNullable<BranchCreateRequest["branch"]>;
type UpdateInput = BranchUpdateRequest["branch"];

interface WorkflowOptions<Throw extends boolean> extends CallOptions<Throw> {
	/** Return a pooled connection string (default `true`). */
	pooled?: boolean;
}

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

export class Branches<DThrow extends boolean> {
	readonly #ctx: RequestContext;

	constructor(ctx: RequestContext) {
		this.#ctx = ctx;
	}

	/** @apiCall GET /projects/{project_id}/branches (cursor-paginated) */
	list(projectId: string, query?: ListQuery): Paginated<Branch, DThrow>;
	list<Throw extends boolean = DThrow>(
		projectId: string,
		query: ListQuery | undefined,
		opts: CallOptions<Throw>,
	): Paginated<Branch, Throw>;
	list(
		projectId: string,
		query?: ListQuery,
		opts?: CallOptions,
	): Paginated<Branch, boolean> {
		return paginate(
			(cursor, signal) =>
				listProjectBranches({
					client: this.#ctx.client,
					path: { project_id: projectId },
					query: { ...query, cursor },
					throwOnError: false,
					signal,
				}),
			(data) => ({
				items: data?.branches ?? [],
				cursor: data?.pagination?.next,
			}),
			() => this.#ctx.deadlineFor(opts),
			this.#ctx.shouldThrow(opts),
		);
	}

	/** @apiCall GET /projects/{project_id}/branches/{branch_id} */
	get(projectId: string, branchId: string): Promise<Outcome<Branch, DThrow>>;
	get<Throw extends boolean = DThrow>(
		projectId: string,
		branchId: string,
		opts: CallOptions<Throw>,
	): Promise<Outcome<Branch, Throw>>;
	get(
		projectId: string,
		branchId: string,
		opts?: CallOptions,
	): Promise<Branch | NeonResult<Branch>> {
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
	create(
		projectId: string,
		input?: CreateInput,
	): Promise<Outcome<Branch, DThrow>>;
	create<Throw extends boolean = DThrow>(
		projectId: string,
		input: CreateInput | undefined,
		opts: CallOptions<Throw>,
	): Promise<Outcome<Branch, Throw>>;
	async create(
		projectId: string,
		input?: CreateInput,
		opts?: CallOptions,
	): Promise<Branch | NeonResult<Branch>> {
		const shouldThrow =
			opts?.throwOnError ?? this.#ctx.defaults.throwOnError;
		const parsed = parseCreateInput(input);
		if (parsed.error) {
			return finalize(err<Branch>(parsed.error), shouldThrow);
		}
		return this.#ctx.run(
			{
				...opts,
				waitForReadiness: opts?.waitForReadiness ?? true,
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
	update(
		projectId: string,
		branchId: string,
		input: UpdateInput,
	): Promise<Outcome<Branch, DThrow>>;
	update<Throw extends boolean = DThrow>(
		projectId: string,
		branchId: string,
		input: UpdateInput,
		opts: CallOptions<Throw>,
	): Promise<Outcome<Branch, Throw>>;
	update(
		projectId: string,
		branchId: string,
		input: UpdateInput,
		opts?: CallOptions,
	): Promise<Branch | NeonResult<Branch>> {
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
	delete(projectId: string, branchId: string): Promise<Outcome<void, DThrow>>;
	delete<Throw extends boolean = DThrow>(
		projectId: string,
		branchId: string,
		opts: CallOptions<Throw>,
	): Promise<Outcome<void, Throw>>;
	delete(
		projectId: string,
		branchId: string,
		opts?: CallOptions,
	): Promise<void | NeonResult<void>> {
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
		projectId: string,
		input?: CreateAndConnectInput,
	): Promise<Outcome<BranchConnection, DThrow>>;
	createAndConnect<Throw extends boolean = DThrow>(
		projectId: string,
		input: CreateAndConnectInput | undefined,
		opts: WorkflowOptions<Throw>,
	): Promise<Outcome<BranchConnection, Throw>>;
	async createAndConnect(
		projectId: string,
		input?: CreateAndConnectInput,
		opts?: WorkflowOptions<boolean>,
	): Promise<BranchConnection | NeonResult<BranchConnection>> {
		const shouldThrow =
			opts?.throwOnError ?? this.#ctx.defaults.throwOnError;
		const result = await this.#ctx.execute(
			{ ...opts, waitForReadiness: opts?.waitForReadiness ?? true },
			(client, signal) =>
				createProjectBranch({
					client,
					path: { project_id: projectId },
					body: {
						branch: {
							name: input?.name,
							parent_id: input?.parentId,
						},
						endpoints: [readWriteEndpoint(input?.compute)],
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
			opts?.pooled ?? true,
		);
		return finalize(out, shouldThrow);
	}

	/**
	 * Resolve the project's default branch (by the `default` flag — not by name).
	 * Returns a `client`-kind {@link NeonError} when no default branch is found.
	 */
	getDefault(projectId: string): Promise<Outcome<Branch, DThrow>>;
	getDefault<Throw extends boolean = DThrow>(
		projectId: string,
		opts: CallOptions<Throw>,
	): Promise<Outcome<Branch, Throw>>;
	async getDefault(
		projectId: string,
		opts?: CallOptions,
	): Promise<Branch | NeonResult<Branch>> {
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
					new NeonError(
						"No default branch found for the project.",
						"client",
					),
				),
				shouldThrow,
			);
		}
		return finalize(ok(branch), shouldThrow);
	}

	/** @apiCall POST /projects/{project_id}/branches/{branch_id}/set_as_default */
	setDefault(
		projectId: string,
		branchId: string,
	): Promise<Outcome<Branch, DThrow>>;
	setDefault<Throw extends boolean = DThrow>(
		projectId: string,
		branchId: string,
		opts: CallOptions<Throw>,
	): Promise<Outcome<Branch, Throw>>;
	setDefault(
		projectId: string,
		branchId: string,
		opts?: CallOptions,
	): Promise<Branch | NeonResult<Branch>> {
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
		projectId: string,
		branchId: string,
		input?: ResetFromParentInput,
	): Promise<Outcome<Branch, DThrow>>;
	resetFromParent<Throw extends boolean = DThrow>(
		projectId: string,
		branchId: string,
		input: ResetFromParentInput | undefined,
		opts: CallOptions<Throw>,
	): Promise<Outcome<Branch, Throw>>;
	async resetFromParent(
		projectId: string,
		branchId: string,
		input?: ResetFromParentInput,
		opts?: CallOptions,
	): Promise<Branch | NeonResult<Branch>> {
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
					new NeonError(
						"Branch has no parent and cannot be reset.",
						"client",
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
						...(input?.preserveUnderName === undefined
							? {}
							: { preserve_under_name: input.preserveUnderName }),
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
		projectId: string,
		branchId: string,
		input: CompareSchemaInput,
	): Promise<Outcome<BranchSchemaCompareResponse, DThrow>>;
	compareSchema<Throw extends boolean = DThrow>(
		projectId: string,
		branchId: string,
		input: CompareSchemaInput,
		opts: CallOptions<Throw>,
	): Promise<Outcome<BranchSchemaCompareResponse, Throw>>;
	compareSchema(
		projectId: string,
		branchId: string,
		input: CompareSchemaInput,
		opts?: CallOptions,
	): Promise<
		BranchSchemaCompareResponse | NeonResult<BranchSchemaCompareResponse>
	> {
		return this.#ctx.run(
			opts,
			(client, signal) =>
				getProjectBranchSchemaComparison({
					client,
					path: { project_id: projectId, branch_id: branchId },
					query: {
						db_name: input.databaseName,
						...(input.baseBranchId === undefined
							? {}
							: { base_branch_id: input.baseBranchId }),
						...(input.lsn === undefined ? {} : { lsn: input.lsn }),
						...(input.timestamp === undefined
							? {}
							: { timestamp: input.timestamp }),
						...(input.baseLsn === undefined
							? {}
							: { base_lsn: input.baseLsn }),
						...(input.baseTimestamp === undefined
							? {}
							: { base_timestamp: input.baseTimestamp }),
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
		projectId: string,
		branchId: string,
		input?: { name?: string },
	): Promise<Outcome<void, DThrow>>;
	finalizeRestore<Throw extends boolean = DThrow>(
		projectId: string,
		branchId: string,
		input: { name?: string } | undefined,
		opts: CallOptions<Throw>,
	): Promise<Outcome<void, Throw>>;
	finalizeRestore(
		projectId: string,
		branchId: string,
		input?: { name?: string },
		opts?: CallOptions,
	): Promise<void | NeonResult<void>> {
		return this.#ctx.run(
			opts,
			(client, signal) =>
				finalizeRestoreBranch({
					client,
					path: { project_id: projectId, branch_id: branchId },
					body: { name: input?.name },
					throwOnError: false,
					signal,
				}),
			() => undefined,
		);
	}
}

function parseCreateInput(input?: CreateInput):
	| {
			error: NeonError;
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
				error: new NeonError(NO_COMPUTE_WITH_COMPUTE, "client"),
			};
		}
		const { noCompute: _noCompute, compute: _compute, ...branch } = input;
		return { branch, noCompute: true };
	}
	const { noCompute: _noCompute, compute, ...branch } = input;
	return { branch, noCompute: false, compute };
}
