import {
	createProjectBranchTrigger,
	deleteProjectBranchTrigger,
	getProjectBranchTrigger,
	listProjectBranchTriggers,
	updateProjectBranchTrigger,
} from "../../client/sdk.gen.js";
import type {
	ScheduleTrigger,
	ScheduleTriggerCreateRequest,
	ScheduleTriggerUpdateRequest,
	StorageObjectCreatedTrigger,
	StorageObjectCreatedTriggerCreateRequest,
	StorageObjectCreatedTriggerUpdateRequest,
	Trigger,
} from "../../client/types.gen.js";
import type { CallOptions, RequestContext } from "../context.js";
import { invalidParamsResult, validateParams } from "../params.js";
import type { NeonResult, Outcome } from "../result.js";

export type TriggersListParams = { projectId: string; branchId: string };
export type TriggersCreateScheduleParams = {
	projectId: string;
	branchId: string;
} & ScheduleTriggerCreateRequest;
export type TriggersCreateStorageParams = {
	projectId: string;
	branchId: string;
} & StorageObjectCreatedTriggerCreateRequest;
export type TriggersCreateParams =
	| TriggersCreateScheduleParams
	| TriggersCreateStorageParams;
export type TriggersGetParams = {
	projectId: string;
	branchId: string;
	triggerId: string;
};
export type TriggersUpdateScheduleParams = TriggersGetParams &
	ScheduleTriggerUpdateRequest;
export type TriggersUpdateStorageParams = TriggersGetParams &
	StorageObjectCreatedTriggerUpdateRequest;
export type TriggersUpdateParams =
	| TriggersUpdateScheduleParams
	| TriggersUpdateStorageParams;
export type TriggersDeleteParams = TriggersGetParams;

/** Branch-scoped Function triggers. */
export class Triggers<DThrow extends boolean> {
	readonly #ctx: RequestContext;

	constructor(ctx: RequestContext) {
		this.#ctx = ctx;
	}

	/** @apiCall GET /projects/{project_id}/branches/{branch_id}/triggers */
	list(params: TriggersListParams): Promise<Outcome<Trigger[], DThrow>>;
	list<Throw extends boolean = DThrow>(
		params: TriggersListParams,
		opts: CallOptions<Throw>,
	): Promise<Outcome<Trigger[], Throw>>;
	list(
		params: TriggersListParams,
		opts?: CallOptions,
	): Promise<Trigger[] | NeonResult<Trigger[]>> {
		const invalid = validateParams(params, "triggers.list", {
			projectId: "string",
			branchId: "string",
		});
		if (invalid) {
			return invalidParamsResult<Trigger[]>(
				invalid,
				this.#ctx.shouldThrow(opts),
			);
		}
		const { projectId, branchId } = params;
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
		params: TriggersCreateScheduleParams,
	): Promise<Outcome<ScheduleTrigger, DThrow>>;
	create(
		params: TriggersCreateStorageParams,
	): Promise<Outcome<StorageObjectCreatedTrigger, DThrow>>;
	create(params: TriggersCreateParams): Promise<Outcome<Trigger, DThrow>>;
	create<Throw extends boolean = DThrow>(
		params: TriggersCreateScheduleParams,
		opts: CallOptions<Throw>,
	): Promise<Outcome<ScheduleTrigger, Throw>>;
	create<Throw extends boolean = DThrow>(
		params: TriggersCreateStorageParams,
		opts: CallOptions<Throw>,
	): Promise<Outcome<StorageObjectCreatedTrigger, Throw>>;
	create<Throw extends boolean = DThrow>(
		params: TriggersCreateParams,
		opts: CallOptions<Throw>,
	): Promise<Outcome<Trigger, Throw>>;
	create(
		params: TriggersCreateParams,
		opts?: CallOptions,
	): Promise<Trigger | NeonResult<Trigger>> {
		const invalid = validateParams(params, "triggers.create", {
			projectId: "string",
			branchId: "string",
		});
		if (invalid) {
			return invalidParamsResult<Trigger>(
				invalid,
				this.#ctx.shouldThrow(opts),
			);
		}
		const { projectId, branchId, ...input } = params;
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
	get(params: TriggersGetParams): Promise<Outcome<Trigger, DThrow>>;
	get<Throw extends boolean = DThrow>(
		params: TriggersGetParams,
		opts: CallOptions<Throw>,
	): Promise<Outcome<Trigger, Throw>>;
	get(
		params: TriggersGetParams,
		opts?: CallOptions,
	): Promise<Trigger | NeonResult<Trigger>> {
		const invalid = validateParams(params, "triggers.get", {
			projectId: "string",
			branchId: "string",
			triggerId: "string",
		});
		if (invalid) {
			return invalidParamsResult<Trigger>(
				invalid,
				this.#ctx.shouldThrow(opts),
			);
		}
		const { projectId, branchId, triggerId } = params;
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
		params: TriggersUpdateScheduleParams,
	): Promise<Outcome<ScheduleTrigger, DThrow>>;
	update(
		params: TriggersUpdateStorageParams,
	): Promise<Outcome<StorageObjectCreatedTrigger, DThrow>>;
	update(params: TriggersUpdateParams): Promise<Outcome<Trigger, DThrow>>;
	update<Throw extends boolean = DThrow>(
		params: TriggersUpdateScheduleParams,
		opts: CallOptions<Throw>,
	): Promise<Outcome<ScheduleTrigger, Throw>>;
	update<Throw extends boolean = DThrow>(
		params: TriggersUpdateStorageParams,
		opts: CallOptions<Throw>,
	): Promise<Outcome<StorageObjectCreatedTrigger, Throw>>;
	update<Throw extends boolean = DThrow>(
		params: TriggersUpdateParams,
		opts: CallOptions<Throw>,
	): Promise<Outcome<Trigger, Throw>>;
	update(
		params: TriggersUpdateParams,
		opts?: CallOptions,
	): Promise<Trigger | NeonResult<Trigger>> {
		const invalid = validateParams(params, "triggers.update", {
			projectId: "string",
			branchId: "string",
			triggerId: "string",
		});
		if (invalid) {
			return invalidParamsResult<Trigger>(
				invalid,
				this.#ctx.shouldThrow(opts),
			);
		}
		const { projectId, branchId, triggerId, ...input } = params;
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
	delete(params: TriggersDeleteParams): Promise<Outcome<void, DThrow>>;
	delete<Throw extends boolean = DThrow>(
		params: TriggersDeleteParams,
		opts: CallOptions<Throw>,
	): Promise<Outcome<void, Throw>>;
	delete(
		params: TriggersDeleteParams,
		opts?: CallOptions,
	): Promise<void | NeonResult<void>> {
		const invalid = validateParams(params, "triggers.delete", {
			projectId: "string",
			branchId: "string",
			triggerId: "string",
		});
		if (invalid) {
			return invalidParamsResult<void>(
				invalid,
				this.#ctx.shouldThrow(opts),
			);
		}
		const { projectId, branchId, triggerId } = params;
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
