import {
	createProjectBranchTrigger,
	deleteProjectBranchTrigger,
	getProjectBranchTrigger,
	listProjectBranchTriggers,
	updateProjectBranchTrigger,
} from "../../client/sdk.gen.js";
import type {
	Trigger,
	TriggerCreateRequest,
	TriggerUpdateRequest,
} from "../../client/types.gen.js";
import type { CallOptions, RequestContext } from "../context.js";
import type { NeonResult, Outcome } from "../result.js";

type CreateInput = TriggerCreateRequest;
type UpdateInput = TriggerUpdateRequest;

/** Branch-scoped Function triggers. v1 only supports `type: "schedule"`. */
export class Triggers<DThrow extends boolean> {
	readonly #ctx: RequestContext;

	constructor(ctx: RequestContext) {
		this.#ctx = ctx;
	}

	/** @apiCall GET /projects/{project_id}/branches/{branch_id}/triggers */
	list(
		projectId: string,
		branchId: string,
	): Promise<Outcome<Trigger[], DThrow>>;
	list<Throw extends boolean = DThrow>(
		projectId: string,
		branchId: string,
		opts: CallOptions<Throw>,
	): Promise<Outcome<Trigger[], Throw>>;
	list(
		projectId: string,
		branchId: string,
		opts?: CallOptions,
	): Promise<Trigger[] | NeonResult<Trigger[]>> {
		return this.#ctx.run(
			opts,
			(client, signal) =>
				listProjectBranchTriggers({
					client,
					path: { project_id: projectId, branch_id: branchId },
					throwOnError: false,
					signal,
				}),
			(data) => data.triggers,
		);
	}

	/** @apiCall POST /projects/{project_id}/branches/{branch_id}/triggers */
	create(
		projectId: string,
		branchId: string,
		input: CreateInput,
	): Promise<Outcome<Trigger, DThrow>>;
	create<Throw extends boolean = DThrow>(
		projectId: string,
		branchId: string,
		input: CreateInput,
		opts: CallOptions<Throw>,
	): Promise<Outcome<Trigger, Throw>>;
	create(
		projectId: string,
		branchId: string,
		input: CreateInput,
		opts?: CallOptions,
	): Promise<Trigger | NeonResult<Trigger>> {
		return this.#ctx.run(
			opts,
			(client, signal) =>
				createProjectBranchTrigger({
					client,
					path: { project_id: projectId, branch_id: branchId },
					body: input,
					throwOnError: false,
					signal,
				}),
			(data) => data.trigger,
		);
	}

	/** @apiCall GET /projects/{project_id}/branches/{branch_id}/triggers/{trigger_id} */
	get(
		projectId: string,
		branchId: string,
		triggerId: string,
	): Promise<Outcome<Trigger, DThrow>>;
	get<Throw extends boolean = DThrow>(
		projectId: string,
		branchId: string,
		triggerId: string,
		opts: CallOptions<Throw>,
	): Promise<Outcome<Trigger, Throw>>;
	get(
		projectId: string,
		branchId: string,
		triggerId: string,
		opts?: CallOptions,
	): Promise<Trigger | NeonResult<Trigger>> {
		return this.#ctx.run(
			opts,
			(client, signal) =>
				getProjectBranchTrigger({
					client,
					path: {
						project_id: projectId,
						branch_id: branchId,
						trigger_id: triggerId,
					},
					throwOnError: false,
					signal,
				}),
			(data) => data.trigger,
		);
	}

	/** @apiCall PATCH /projects/{project_id}/branches/{branch_id}/triggers/{trigger_id} */
	update(
		projectId: string,
		branchId: string,
		triggerId: string,
		input: UpdateInput,
	): Promise<Outcome<Trigger, DThrow>>;
	update<Throw extends boolean = DThrow>(
		projectId: string,
		branchId: string,
		triggerId: string,
		input: UpdateInput,
		opts: CallOptions<Throw>,
	): Promise<Outcome<Trigger, Throw>>;
	update(
		projectId: string,
		branchId: string,
		triggerId: string,
		input: UpdateInput,
		opts?: CallOptions,
	): Promise<Trigger | NeonResult<Trigger>> {
		return this.#ctx.run(
			opts,
			(client, signal) =>
				updateProjectBranchTrigger({
					client,
					path: {
						project_id: projectId,
						branch_id: branchId,
						trigger_id: triggerId,
					},
					body: input,
					throwOnError: false,
					signal,
				}),
			(data) => data.trigger,
		);
	}

	/** @apiCall DELETE /projects/{project_id}/branches/{branch_id}/triggers/{trigger_id} */
	delete(
		projectId: string,
		branchId: string,
		triggerId: string,
	): Promise<Outcome<void, DThrow>>;
	delete<Throw extends boolean = DThrow>(
		projectId: string,
		branchId: string,
		triggerId: string,
		opts: CallOptions<Throw>,
	): Promise<Outcome<void, Throw>>;
	delete(
		projectId: string,
		branchId: string,
		triggerId: string,
		opts?: CallOptions,
	): Promise<void | NeonResult<void>> {
		return this.#ctx.runVoid(opts, (client, signal) =>
			deleteProjectBranchTrigger({
				client,
				path: {
					project_id: projectId,
					branch_id: branchId,
					trigger_id: triggerId,
				},
				throwOnError: false,
				signal,
			}),
		);
	}
}
