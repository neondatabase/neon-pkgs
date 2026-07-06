import {
	createProjectBranch,
	deleteProjectBranch,
	finalizeRestoreBranch,
	getProjectBranch,
	listProjectBranches,
	recoverProjectBranch,
	setDefaultProjectBranch,
	updateProjectBranch,
} from "../../client/sdk.gen.js";
import type {
	Branch,
	BranchCreateRequest,
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
type CreateInput = NonNullable<BranchCreateRequest["branch"]>;
type UpdateInput = BranchUpdateRequest["branch"];

/** Per-call options for the connect/compute workflows. */
interface WorkflowOptions<Throw extends boolean> extends CallOptions<Throw> {
	/** Return a pooled connection string (default `true`). */
	pooled?: boolean;
}

/** Input for {@link Branches.createWithCompute}. */
export interface CreateWithComputeInput {
	name?: string;
	/** Parent branch id. Defaults to the project's default branch. */
	parentId?: string;
	/** Autoscaling settings for the branch's read-write endpoint. */
	compute?: {
		minCu?: number;
		maxCu?: number;
		suspendTimeoutSeconds?: number;
	};
}

/** A branch with its read-write endpoint and a ready-to-use connection string. */
export interface BranchWithCompute {
	branch: Branch;
	endpoint: Endpoint;
	connectionString: string;
}

/** Branch resource — one API call per CRUD method, plus the `createWithCompute` workflow. */
export class Branches<DThrow extends boolean> {
	readonly #ctx: RequestContext;

	constructor(ctx: RequestContext) {
		this.#ctx = ctx;
	}

	/** @apiCall GET /projects/{project_id}/branches (cursor-paginated) */
	list(projectId: string, query?: ListQuery): Paginated<Branch> {
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
			(client) =>
				getProjectBranch({
					client,
					path: { project_id: projectId, branch_id: branchId },
					throwOnError: false,
				}),
			(data) => data.branch,
		);
	}

	/** @apiCall POST /projects/{project_id}/branches */
	create(
		projectId: string,
		input?: CreateInput,
	): Promise<Outcome<Branch, DThrow>>;
	create<Throw extends boolean = DThrow>(
		projectId: string,
		input: CreateInput | undefined,
		opts: CallOptions<Throw>,
	): Promise<Outcome<Branch, Throw>>;
	create(
		projectId: string,
		input?: CreateInput,
		opts?: CallOptions,
	): Promise<Branch | NeonResult<Branch>> {
		return this.#ctx.run(
			opts,
			(client) =>
				createProjectBranch({
					client,
					path: { project_id: projectId },
					body: { branch: input },
					throwOnError: false,
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
			(client) =>
				updateProjectBranch({
					client,
					path: { project_id: projectId, branch_id: branchId },
					body: { branch: input },
					throwOnError: false,
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
		return this.#ctx.runVoid(opts, (client) =>
			deleteProjectBranch({
				client,
				path: { project_id: projectId, branch_id: branchId },
				throwOnError: false,
			}),
		);
	}

	/**
	 * Create a branch **with a read-write endpoint** and return a ready-to-use connection
	 * string. One API call (Neon creates the endpoint inline) plus readiness polling.
	 *
	 * @workflow createProjectBranch (with endpoint) + waitForReadiness
	 */
	createWithCompute(
		projectId: string,
		input: CreateWithComputeInput,
	): Promise<Outcome<BranchWithCompute, DThrow>>;
	createWithCompute<Throw extends boolean = DThrow>(
		projectId: string,
		input: CreateWithComputeInput,
		opts: WorkflowOptions<Throw>,
	): Promise<Outcome<BranchWithCompute, Throw>>;
	async createWithCompute(
		projectId: string,
		input: CreateWithComputeInput,
		opts?: WorkflowOptions<boolean>,
	): Promise<BranchWithCompute | NeonResult<BranchWithCompute>> {
		const shouldThrow =
			opts?.throwOnError ?? this.#ctx.defaults.throwOnError;
		const result = await this.#ctx.execute(
			{ ...opts, waitForReadiness: opts?.waitForReadiness ?? true },
			(client) =>
				createProjectBranch({
					client,
					path: { project_id: projectId },
					body: {
						branch: { name: input.name, parent_id: input.parentId },
						endpoints: [
							{
								type: "read_write",
								autoscaling_limit_min_cu: input.compute?.minCu,
								autoscaling_limit_max_cu: input.compute?.maxCu,
								suspend_timeout_seconds:
									input.compute?.suspendTimeoutSeconds,
							},
						],
					},
					throwOnError: false,
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
			(client) =>
				listProjectBranches({
					client,
					path: { project_id: projectId },
					throwOnError: false,
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
			(client) =>
				setDefaultProjectBranch({
					client,
					path: { project_id: projectId, branch_id: branchId },
					throwOnError: false,
				}),
			(data) => data.branch,
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
			(client) =>
				finalizeRestoreBranch({
					client,
					path: { project_id: projectId, branch_id: branchId },
					body: { name: input?.name },
					throwOnError: false,
				}),
			() => undefined,
		);
	}

	/**
	 * Recover a soft-deleted branch within the 7-day recovery window.
	 *
	 * @apiCall POST /projects/{project_id}/branches/{branch_id}/recover
	 */
	recover(
		projectId: string,
		branchId: string,
	): Promise<Outcome<Branch, DThrow>>;
	recover<Throw extends boolean = DThrow>(
		projectId: string,
		branchId: string,
		opts: CallOptions<Throw>,
	): Promise<Outcome<Branch, Throw>>;
	recover(
		projectId: string,
		branchId: string,
		opts?: CallOptions,
	): Promise<Branch | NeonResult<Branch>> {
		return this.#ctx.run(
			opts,
			(client) =>
				recoverProjectBranch({
					client,
					path: { project_id: projectId, branch_id: branchId },
					throwOnError: false,
				}),
			(data) => data.branch,
		);
	}
}
