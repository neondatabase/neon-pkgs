import fc from "fast-check";
import { describe, expect, it } from "vitest";

import type { WireChange, WireRow } from "../protocol/messages.js";
import {
	BaselineSyncPublicationReconciler,
	type ReconciledBatch,
	type ReconciliationTarget,
} from "./reconciler.js";
import {
	accept,
	baselineSyncBatch,
	baselineSyncEnd,
	baselineSyncStart,
	commit,
} from "./reconciler.test-helpers.js";

const LIVE_ID = "9";
type Message = Parameters<BaselineSyncPublicationReconciler["accept"]>[0];
type Operation =
	| { readonly kind: "publication"; readonly changes: readonly WireChange[] }
	| { readonly kind: "reset"; readonly rows: readonly WireRow[] };
interface Scenario {
	readonly initial: readonly WireRow[];
	readonly operations: readonly Operation[];
	readonly delivery: "after" | "during" | "before";
}
type Observation =
	| { readonly kind: "reset"; readonly rows: string }
	| {
			readonly kind: "batch";
			readonly changes: string;
			readonly txids: string;
	  }
	| { readonly kind: "caught_up"; readonly rows: string }
	| { readonly kind: "reset_required" };

const rowKey = fc
	.integer({ min: 0, max: 7 })
	.map((value) => value.toString(16).padStart(64, "0"));
const cell = fc.oneof(fc.string({ maxLength: 6 }), fc.constant(null));
const generatedRow = fc.record({
	row_key: rowKey,
	values: cell.map((value) => [value]),
});
const generatedRows = fc.uniqueArray(generatedRow, {
	maxLength: 5,
	selector: (row) => row.row_key,
});
const generatedChange: fc.Arbitrary<WireChange> = fc.oneof(
	fc.record({
		op: fc.constant("upsert" as const),
		row_key: rowKey,
		values: cell.map((value) => [value]),
	}),
	fc.record({ op: fc.constant("remove" as const), row_key: rowKey }),
);
const generatedOperation: fc.Arbitrary<Operation> = fc.oneof(
	fc.record({
		kind: fc.constant("publication" as const),
		changes: fc.array(generatedChange, { minLength: 1, maxLength: 4 }),
	}),
	fc.record({ kind: fc.constant("reset" as const), rows: generatedRows }),
);
const generatedScenario: fc.Arbitrary<Scenario> = fc.record({
	initial: generatedRows,
	operations: fc.array(generatedOperation, { maxLength: 8 }),
	delivery: fc.constantFrom("after", "during", "before"),
});

describe("reconciliation oracle", () => {
	it("matches an independent reducer across generated interleavings", () => {
		fc.assert(
			fc.property(generatedScenario, (scenario) => {
				const messages = render(scenario);
				expect(driveReconciler(messages)).toEqual(
					reduceIndependently(messages),
				);
			}),
			{ numRuns: 300 },
		);
	});
});

function render(scenario: Scenario): Message[] {
	const messages: Message[] = [];
	let epoch = 1;
	let sequence = 1;
	let publication = 1;

	const baselineSync = (rows: readonly WireRow[]): void => {
		messages.push(baselineSyncStart(String(epoch)));
		rows.forEach((row, index) => {
			messages.push(baselineSyncBatch(index, [row], String(epoch)));
		});
		messages.push(baselineSyncEnd(rows.length, String(epoch)));
	};

	baselineSync(scenario.initial);
	for (const operation of scenario.operations) {
		const publicationId = String(publication++);
		messages.push({ type: "open", publication_id: publicationId });
		if (operation.kind === "publication") {
			messages.push({
				type: "keyed_results",
				publication_id: publicationId,
				index: 0,
				txids: ["100"],
				targets: [
					{
						live_id: LIVE_ID,
						epoch: String(epoch),
						sequence: String(sequence++),
					},
				],
				changes: [...operation.changes],
			});
		} else {
			epoch += 1;
			sequence = 1;
			messages.push({
				type: "reset_required",
				publication_id: publicationId,
				index: 0,
				targets: [
					{
						live_id: LIVE_ID,
						epoch: String(epoch),
						first_sequence: "1",
					},
				],
			});
		}
		messages.push(commit(publicationId, 1));
		if (operation.kind === "reset") baselineSync(operation.rows);
	}

	movePublicationsAcrossBaselineSyncs(messages, scenario.delivery);
	return messages;
}

function movePublicationsAcrossBaselineSyncs(
	messages: Message[],
	delivery: Scenario["delivery"],
): void {
	if (delivery === "after") return;
	for (let index = 0; index < messages.length; index += 1) {
		if (messages[index]?.type !== "baseline_sync_start") continue;
		const end = messages.findIndex(
			(message, position) =>
				position >= index && message.type === "baseline_sync_end",
		);
		if (
			messages[end + 1]?.type !== "open" ||
			messages[end + 2]?.type !== "keyed_results"
		)
			continue;
		const publication = messages.splice(end + 1, 3);
		messages.splice(delivery === "before" ? index : end, 0, ...publication);
		index = end + publication.length;
	}
}

function driveReconciler(messages: readonly Message[]): readonly Observation[] {
	const observations: Observation[] = [];
	const rows = new Map<string, WireRow["values"]>();
	const target: ReconciliationTarget = {
		baselineSyncStarted: () => undefined,
		installContinuity: () => undefined,
		advanceContinuity: () => undefined,
		installReset: (reset) => replaceRows(rows, reset),
		applyBatch: (changes) => applyChanges(rows, changes),
		publishReset: (reset) =>
			observations.push({
				kind: "reset",
				rows: normalizeRows(reset),
			}),
		publishBatch: (batch) => observations.push(batchObservation(batch)),
		applyProgress: () => {},
		caughtUp: () =>
			observations.push({
				kind: "caught_up",
				rows: normalizeTable(rows),
			}),
		baselineSyncCompleted: () => undefined,
		resetRequired: () => observations.push({ kind: "reset_required" }),
		decodeFailed: (error) => {
			throw error;
		},
	};
	const reconciler = new BaselineSyncPublicationReconciler();
	reconciler.add({
		liveId: LIVE_ID,
		epoch: "1",
		firstSequence: "1",
		columnCount: 1,
		target,
	});
	for (const message of messages) accept(reconciler, message);
	return observations;
}

function reduceIndependently(
	messages: readonly Message[],
): readonly Observation[] {
	const observations: Observation[] = [];
	const rows = new Map<string, WireRow["values"]>();
	let baseline: WireRow[] = [];
	let pendingChanges: WireChange[] = [];
	let pendingTxids: string[] = [];
	let backlog: ReconciledBatch[] = [];
	let live = false;
	let resetPending = false;
	let changesPending = false;

	for (const message of messages) {
		switch (message.type) {
			case "baseline_sync_start":
				baseline = [];
				break;
			case "baseline_sync_batch":
				baseline.push(...message.rows);
				break;
			case "baseline_sync_end":
				replaceRows(rows, baseline);
				for (const batch of backlog) applyChanges(rows, batch.changes);
				observations.push({
					kind: "reset",
					rows: normalizeRows(baseline),
				});
				observations.push(...backlog.map(batchObservation));
				backlog = [];
				live = true;
				observations.push({
					kind: "caught_up",
					rows: normalizeTable(rows),
				});
				break;
			case "open":
				pendingChanges = [];
				pendingTxids = [];
				resetPending = false;
				changesPending = false;
				break;
			case "keyed_results":
				pendingChanges.push(...message.changes);
				pendingTxids = [...message.txids];
				changesPending = true;
				break;
			case "reset_required":
				resetPending = true;
				break;
			case "commit":
				if (resetPending) {
					backlog = [];
					live = false;
					observations.push({ kind: "reset_required" });
				} else if (changesPending) {
					const batch = {
						changes: [...pendingChanges],
						txids: [...pendingTxids],
					};
					if (live) {
						applyChanges(rows, batch.changes);
						observations.push(batchObservation(batch));
					} else backlog.push(batch);
				}
				break;
		}
	}
	return observations;
}

function replaceRows(
	table: Map<string, WireRow["values"]>,
	rows: readonly WireRow[],
): void {
	table.clear();
	for (const row of rows) table.set(row.row_key, row.values);
}

function applyChanges(
	rows: Map<string, WireRow["values"]>,
	changes: readonly WireChange[],
): void {
	for (const change of changes) {
		if (change.op === "upsert") rows.set(change.row_key, change.values);
		else rows.delete(change.row_key);
	}
}

function batchObservation(batch: ReconciledBatch): Observation {
	return {
		kind: "batch",
		changes: JSON.stringify(batch.changes),
		txids: JSON.stringify(batch.txids),
	};
}

function normalizeRows(rows: readonly WireRow[]): string {
	return normalizeTable(
		new Map(rows.map((row) => [row.row_key, row.values])),
	);
}

function normalizeTable(rows: ReadonlyMap<string, WireRow["values"]>): string {
	return JSON.stringify(
		[...rows.entries()].sort(([left], [right]) =>
			left.localeCompare(right),
		),
	);
}
