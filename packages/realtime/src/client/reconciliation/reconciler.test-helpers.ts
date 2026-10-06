import { vi } from "vitest";

import type {
	ServerMessage,
	WireChange,
	WireRow,
} from "../protocol/messages.js";
import {
	BaselineSyncPublicationReconciler,
	type ReconciledBatch,
	type ReconciliationTarget,
} from "./reconciler.js";

export const ROW_A = "a".repeat(64);
export const ROW_B = "b".repeat(64);
export const ROW_C = "c".repeat(64);
export const HISTORY_A = "1".repeat(64);

export type MockTarget = ReconciliationTarget & {
	[Key in keyof ReconciliationTarget]: ReturnType<typeof vi.fn>;
};

export function target(events: string[] = [], prefix = ""): MockTarget {
	const label = (value: string) => `${prefix ? `${prefix}:` : ""}${value}`;
	return {
		baselineSyncStarted: vi.fn(),
		installReset: vi.fn((rows: readonly WireRow[]) =>
			events.push(label(`installReset:${keys(rows)}`)),
		),
		applyBatch: vi.fn((changes: readonly WireChange[]) =>
			events.push(label(`apply:${changeKeys(changes)}`)),
		),
		installContinuity: vi.fn(),
		advanceContinuity: vi.fn(),
		publishReset: vi.fn((rows: readonly WireRow[]) =>
			events.push(label(`publishReset:${keys(rows)}`)),
		),
		publishBatch: vi.fn((batch: ReconciledBatch) =>
			events.push(
				label(
					`publishBatch:${batch.txids}:${changeKeys(batch.changes)}`,
				),
			),
		),
		caughtUp: vi.fn(() => events.push(label("caughtUp"))),
		baselineSyncCompleted: vi.fn(),
		applyProgress: vi.fn(() => events.push(label("progress"))),
		resetRequired: vi.fn(() => events.push(label("resetRequired"))),
		decodeFailed: vi.fn((error: unknown) => {
			throw error;
		}),
	};
}

export function subscribed(
	targetState: ReconciliationTarget,
): BaselineSyncPublicationReconciler {
	const reconciler = new BaselineSyncPublicationReconciler();
	reconciler.add({
		liveId: "9",
		epoch: "1",
		firstSequence: "1",
		columnCount: 1,
		target: targetState,
	});
	return reconciler;
}

export function completeEmptyBaselineSync(
	reconciler: BaselineSyncPublicationReconciler,
	liveId = "9",
): void {
	accept(reconciler, { ...baselineSyncStart(), live_id: liveId });
	accept(reconciler, { ...baselineSyncEnd(0), live_id: liveId });
}

export function keyedPublication(
	reconciler: BaselineSyncPublicationReconciler,
	publicationId: string,
	epoch: string,
	sequence: string,
	changes: readonly WireChange[],
	txids: readonly string[] = ["7"],
): void {
	for (const message of publicationMessages(
		publicationId,
		epoch,
		sequence,
		changes,
		txids,
	)) {
		accept(reconciler, message);
	}
}

export function publicationMessages(
	publicationId: string,
	epoch: string,
	sequence: string,
	changes: readonly WireChange[],
	txids: readonly string[] = ["7"],
): Parameters<BaselineSyncPublicationReconciler["accept"]>[0][] {
	return [
		{ type: "open", publication_id: publicationId },
		keyedResults(publicationId, 0, epoch, sequence, changes, txids),
		commit(publicationId, 1),
	];
}

export function resetPublication(
	reconciler: BaselineSyncPublicationReconciler,
	publicationId: string,
	epoch: string,
): void {
	accept(reconciler, { type: "open", publication_id: publicationId });
	accept(reconciler, resetRequired(publicationId, 0, epoch));
	accept(reconciler, commit(publicationId, 1));
}

export function baselineSyncStart(
	epoch = "1",
	attempt = "1",
): Extract<ServerMessage, { type: "baseline_sync_start" }> {
	return {
		type: "baseline_sync_start",
		live_id: "9",
		epoch,
		baseline_sync_attempt: attempt,
		continuity: { history: HISTORY_A, lsn: "0/1" },
		mvcc: { xmin: "1", xmax: "2", xip: [] },
	};
}

export function baselineSyncBatch(
	index: number,
	rows: readonly WireRow[],
	epoch = "1",
	attempt = "1",
): Extract<ServerMessage, { type: "baseline_sync_batch" }> {
	return {
		type: "baseline_sync_batch",
		live_id: "9",
		epoch,
		baseline_sync_attempt: attempt,
		index,
		rows: [...rows],
	};
}

export function baselineSyncEnd(
	batchCount: number,
	epoch = "1",
	attempt = "1",
): Extract<ServerMessage, { type: "baseline_sync_end" }> {
	return {
		type: "baseline_sync_end",
		live_id: "9",
		epoch,
		baseline_sync_attempt: attempt,
		batch_count: batchCount,
	};
}

export function keyedResults(
	publicationId: string,
	index: number,
	epoch: string,
	sequence: string,
	changes: readonly WireChange[],
	txids: readonly string[] = ["7"],
): Extract<ServerMessage, { type: "keyed_results" }> {
	return {
		type: "keyed_results",
		publication_id: publicationId,
		index,
		txids: [...txids],
		targets: [{ live_id: "9", epoch, sequence }],
		changes: [...changes],
	};
}

export function resetRequired(
	publicationId: string,
	index: number,
	epoch: string,
): Extract<ServerMessage, { type: "reset_required" }> {
	return {
		type: "reset_required",
		publication_id: publicationId,
		index,
		targets: [{ live_id: "9", epoch, first_sequence: "1" }],
	};
}

export function commit(
	publicationId: string,
	bodyCount: number,
	lsn = "0/10",
): Extract<ServerMessage, { type: "commit" }> {
	return {
		type: "commit",
		publication_id: publicationId,
		body_count: bodyCount,
		frontier: { lsn },
	};
}

export function row(rowKey: string, value: string): WireRow {
	return { row_key: rowKey, values: [value] };
}

export function upsert(rowKey: string, value: string): WireChange {
	return { op: "upsert", row_key: rowKey, values: [value] };
}

export function accept(
	reconciler: BaselineSyncPublicationReconciler,
	message: Parameters<BaselineSyncPublicationReconciler["accept"]>[0],
): void {
	reconciler.accept(message, wireBytes(message));
}

export function wireBytes(value: object): number {
	return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

export function keys(rows: readonly WireRow[]): string {
	return rows.map((current) => current.row_key[0]).join(",");
}

export function changeKeys(changes: readonly WireChange[]): string {
	return changes.map((change) => change.row_key[0]).join(",");
}
