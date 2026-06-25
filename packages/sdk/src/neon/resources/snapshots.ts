import {
	createSnapshot,
	deleteSnapshot,
	getSnapshotSchedule,
	listSnapshots,
	restoreSnapshot,
	setSnapshotSchedule,
	updateSnapshot,
} from "../../client/sdk.gen.js";
import type {
	BackupSchedule,
	Branch,
	Snapshot,
	SnapshotUpdateRequest,
} from "../../client/types.gen.js";
import type { CallOptions, RequestContext } from "../context.js";
import type { NeonResult, Outcome } from "../result.js";

type UpdateInput = SnapshotUpdateRequest["snapshot"];

/** Input for {@link Snapshots.restore}. */
export interface RestoreSnapshotInput {
	/** Name for the newly restored branch. Auto-generated when omitted. */
	name?: string;
	/** Target branch to restore onto. Defaults to the snapshot's source branch. */
	targetBranchId?: string;
}

/** Snapshot resource. */
export class Snapshots<DThrow extends boolean> {
	readonly #ctx: RequestContext;

	constructor(ctx: RequestContext) {
		this.#ctx = ctx;
	}

	/** @apiCall GET /projects/{project_id}/snapshots */
	list(projectId: string): Promise<Outcome<Snapshot[], DThrow>>;
	list<Throw extends boolean = DThrow>(
		projectId: string,
		opts: CallOptions<Throw>,
	): Promise<Outcome<Snapshot[], Throw>>;
	list(
		projectId: string,
		opts?: CallOptions,
	): Promise<Snapshot[] | NeonResult<Snapshot[]>> {
		return this.#ctx.run(
			opts,
			(client) =>
				listSnapshots({
					client,
					path: { project_id: projectId },
					throwOnError: false,
				}),
			(data) => data.snapshots,
		);
	}

	/** @apiCall POST /projects/{project_id}/branches/{branch_id}/snapshot */
	create(
		projectId: string,
		branchId: string,
	): Promise<Outcome<Snapshot, DThrow>>;
	create<Throw extends boolean = DThrow>(
		projectId: string,
		branchId: string,
		opts: CallOptions<Throw>,
	): Promise<Outcome<Snapshot, Throw>>;
	create(
		projectId: string,
		branchId: string,
		opts?: CallOptions,
	): Promise<Snapshot | NeonResult<Snapshot>> {
		return this.#ctx.run(
			opts,
			(client) =>
				createSnapshot({
					client,
					path: { project_id: projectId, branch_id: branchId },
					throwOnError: false,
				}),
			(data) => data.snapshot,
		);
	}

	/** @apiCall PATCH /projects/{project_id}/snapshots/{snapshot_id} */
	update(
		projectId: string,
		snapshotId: string,
		input: UpdateInput,
	): Promise<Outcome<Snapshot, DThrow>>;
	update<Throw extends boolean = DThrow>(
		projectId: string,
		snapshotId: string,
		input: UpdateInput,
		opts: CallOptions<Throw>,
	): Promise<Outcome<Snapshot, Throw>>;
	update(
		projectId: string,
		snapshotId: string,
		input: UpdateInput,
		opts?: CallOptions,
	): Promise<Snapshot | NeonResult<Snapshot>> {
		return this.#ctx.run(
			opts,
			(client) =>
				updateSnapshot({
					client,
					path: { project_id: projectId, snapshot_id: snapshotId },
					body: { snapshot: input },
					throwOnError: false,
				}),
			(data) => data.snapshot,
		);
	}

	/** @apiCall DELETE /projects/{project_id}/snapshots/{snapshot_id} */
	delete(
		projectId: string,
		snapshotId: string,
	): Promise<Outcome<void, DThrow>>;
	delete<Throw extends boolean = DThrow>(
		projectId: string,
		snapshotId: string,
		opts: CallOptions<Throw>,
	): Promise<Outcome<void, Throw>>;
	delete(
		projectId: string,
		snapshotId: string,
		opts?: CallOptions,
	): Promise<void | NeonResult<void>> {
		return this.#ctx.run(
			opts,
			(client) =>
				deleteSnapshot({
					client,
					path: { project_id: projectId, snapshot_id: snapshotId },
					throwOnError: false,
				}),
			() => undefined,
		);
	}

	/**
	 * Restore a snapshot into a branch (creating it). Returns the restored branch.
	 *
	 * @apiCall POST /projects/{project_id}/snapshots/{snapshot_id}/restore
	 */
	restore(
		projectId: string,
		snapshotId: string,
		input?: RestoreSnapshotInput,
	): Promise<Outcome<Branch, DThrow>>;
	restore<Throw extends boolean = DThrow>(
		projectId: string,
		snapshotId: string,
		input: RestoreSnapshotInput | undefined,
		opts: CallOptions<Throw>,
	): Promise<Outcome<Branch, Throw>>;
	restore(
		projectId: string,
		snapshotId: string,
		input?: RestoreSnapshotInput,
		opts?: CallOptions,
	): Promise<Branch | NeonResult<Branch>> {
		return this.#ctx.run(
			opts,
			(client) =>
				restoreSnapshot({
					client,
					path: { project_id: projectId, snapshot_id: snapshotId },
					body: {
						name: input?.name,
						target_branch_id: input?.targetBranchId,
					},
					throwOnError: false,
				}),
			(data) => data.branch,
		);
	}

	/** @apiCall GET /projects/{project_id}/branches/{branch_id}/backup_schedule */
	getSchedule(
		projectId: string,
		branchId: string,
	): Promise<Outcome<BackupSchedule, DThrow>>;
	getSchedule<Throw extends boolean = DThrow>(
		projectId: string,
		branchId: string,
		opts: CallOptions<Throw>,
	): Promise<Outcome<BackupSchedule, Throw>>;
	getSchedule(
		projectId: string,
		branchId: string,
		opts?: CallOptions,
	): Promise<BackupSchedule | NeonResult<BackupSchedule>> {
		return this.#ctx.run(
			opts,
			(client) =>
				getSnapshotSchedule({
					client,
					path: { project_id: projectId, branch_id: branchId },
					throwOnError: false,
				}),
			(data) => data,
		);
	}

	/** @apiCall PUT /projects/{project_id}/branches/{branch_id}/backup_schedule */
	setSchedule(
		projectId: string,
		branchId: string,
		schedule: BackupSchedule,
	): Promise<Outcome<void, DThrow>>;
	setSchedule<Throw extends boolean = DThrow>(
		projectId: string,
		branchId: string,
		schedule: BackupSchedule,
		opts: CallOptions<Throw>,
	): Promise<Outcome<void, Throw>>;
	setSchedule(
		projectId: string,
		branchId: string,
		schedule: BackupSchedule,
		opts?: CallOptions,
	): Promise<void | NeonResult<void>> {
		return this.#ctx.run(
			opts,
			(client) =>
				setSnapshotSchedule({
					client,
					path: { project_id: projectId, branch_id: branchId },
					body: schedule,
					throwOnError: false,
				}),
			() => undefined,
		);
	}
}
