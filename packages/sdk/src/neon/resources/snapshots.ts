import {
	createSnapshot,
	deleteProjectBranch,
	deleteSnapshot,
	finalizeRestoreBranch,
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
import { err, finalize, type NeonResult, type Outcome, ok } from "../result.js";

type UpdateInput = SnapshotUpdateRequest["snapshot"];

/**
 * Inspect a freshly restored (not-yet-finalized) branch and decide whether to commit.
 * Return `true` to finalize the restore, `false` to abort it.
 */
export type RestorePreview = (branch: Branch) => boolean | Promise<boolean>;

/** Options for {@link Snapshots.create} (point-in-time + naming). */
export interface CreateSnapshotInput {
	/** A name for the snapshot. */
	name?: string;
	/** Take the snapshot at this timestamp (ISO 8601). Mutually exclusive with `lsn`. */
	timestamp?: string;
	/** Take the snapshot at this LSN. Mutually exclusive with `timestamp`. */
	lsn?: string;
	/** When the snapshot is automatically deleted (ISO 8601). */
	expiresAt?: string;
}

/** Input for {@link Snapshots.restore}. */
export interface RestoreSnapshotInput {
	/** Name for the restored branch. Auto-generated when omitted. */
	name?: string;
	/** Branch to restore onto. Defaults to the snapshot's source branch. */
	targetBranchId?: string;
	/**
	 * Finalize immediately (move computes onto the restored branch). Defaults to `true`
	 * when restoring as a new branch (nothing to clobber) and `false` when restoring
	 * **onto** an existing branch (`targetBranchId`), so you can preview before the swap.
	 * Ignored when `preview` is set (the preview flow always restores un-finalized first).
	 */
	finalize?: boolean;
	/**
	 * Transaction-style restore: receives the restored (un-finalized) branch; return `true`
	 * to finalize (commit) or `false` to abort. On abort the preview branch is deleted
	 * unless `keepOnAbort` is set. Either way `restore` resolves to the restored `Branch`.
	 */
	preview?: RestorePreview;
	/** Keep the preview branch when `preview` returns `false` (default: delete it). */
	keepOnAbort?: boolean;
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
		input?: CreateSnapshotInput,
	): Promise<Outcome<Snapshot, DThrow>>;
	create<Throw extends boolean = DThrow>(
		projectId: string,
		branchId: string,
		input: CreateSnapshotInput | undefined,
		opts: CallOptions<Throw>,
	): Promise<Outcome<Snapshot, Throw>>;
	create(
		projectId: string,
		branchId: string,
		input?: CreateSnapshotInput,
		opts?: CallOptions,
	): Promise<Snapshot | NeonResult<Snapshot>> {
		return this.#ctx.run(
			opts,
			(client) =>
				createSnapshot({
					client,
					path: { project_id: projectId, branch_id: branchId },
					query: {
						name: input?.name,
						timestamp: input?.timestamp,
						lsn: input?.lsn,
						expires_at: input?.expiresAt,
					},
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
	 * Restore a snapshot into a branch. Returns the restored branch.
	 *
	 * - **As a new branch** (no `targetBranchId`): finalizes by default — ready to use.
	 * - **Onto an existing branch** (`targetBranchId`): does **not** finalize by default,
	 *   so you can preview before the compute swap. Finish later with
	 *   `branches.finalizeRestore`, or pass a `preview` callback to do it transactionally.
	 *
	 * With `preview`, this restores un-finalized, runs your callback against the restored
	 * branch, then finalizes (commit) or deletes the preview branch (abort, unless
	 * `keepOnAbort`). Either way it resolves to the restored `Branch`.
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
	async restore(
		projectId: string,
		snapshotId: string,
		input?: RestoreSnapshotInput,
		opts?: CallOptions,
	): Promise<Branch | NeonResult<Branch>> {
		const shouldThrow =
			opts?.throwOnError ?? this.#ctx.defaults.throwOnError;
		const preview = input?.preview;
		// New branch → finalize by default; onto existing → preview-first by default.
		// The preview flow always restores un-finalized so it can inspect first.
		const finalizeNow = preview
			? false
			: (input?.finalize ?? input?.targetBranchId === undefined);

		const restored = await this.#ctx.execute(
			{
				...opts,
				waitForReadiness: preview ? true : opts?.waitForReadiness,
			},
			(client) =>
				restoreSnapshot({
					client,
					path: { project_id: projectId, snapshot_id: snapshotId },
					body: {
						name: input?.name,
						target_branch_id: input?.targetBranchId,
						finalize_restore: finalizeNow,
					},
					throwOnError: false,
				}),
			(data) => data.branch,
		);
		if (restored.error || !preview) {
			return finalize(restored, shouldThrow);
		}

		const branch = restored.data;
		const commit = await preview(branch);
		const step = commit
			? await this.#ctx.execute(
					{ ...opts, waitForReadiness: true },
					(client) =>
						finalizeRestoreBranch({
							client,
							path: {
								project_id: projectId,
								branch_id: branch.id,
							},
							throwOnError: false,
						}),
					() => undefined,
				)
			: input?.keepOnAbort
				? ok(undefined)
				: await this.#ctx.execute(
						{ ...opts, waitForReadiness: true },
						(client) =>
							deleteProjectBranch({
								client,
								path: {
									project_id: projectId,
									branch_id: branch.id,
								},
								throwOnError: false,
							}),
						() => undefined,
					);

		if (step.error) return finalize(err<Branch>(step.error), shouldThrow);
		return finalize(ok(branch), shouldThrow);
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
