import { describe, expect, it } from "vitest";

import {
	type ReconciliationLimits,
	SnapshotPublicationReconciler,
} from "./reconciler.js";
import {
	accept,
	completeEmptySnapshot,
	keyedPublication,
	publicationMessages,
	ROW_A,
	row,
	snapshotChunk,
	snapshotEnd,
	snapshotStart,
	target,
	upsert,
	wireBytes,
} from "./reconciler.test-helpers.js";

describe("reconciliation resource bounds", () => {
	it("counts every snapshot frame against an exact UTF-8 byte limit", () => {
		const messages = [
			snapshotStart(),
			snapshotChunk(0, [row(ROW_A, "é")]),
			snapshotEnd(1),
		];
		const size = messages.reduce(
			(total, message) => total + wireBytes(message),
			0,
		);

		const exact = subscribed({
			maxSnapshotBytes: size,
			maxPublicationBytes: 10_000,
		});
		for (const message of messages) accept(exact, message);

		const over = subscribed({
			maxSnapshotBytes: size - 1,
			maxPublicationBytes: 10_000,
		});
		expect(() => {
			for (const message of messages) accept(over, message);
		}).toThrow("snapshot exceeds the byte limit");
	});

	it("counts open, bodies, and commit against the publication limit", () => {
		const messages = publicationMessages(
			"p",
			"1",
			"1",
			[upsert(ROW_A, "é")],
			["7"],
		);
		const size = messages.reduce(
			(total, message) => total + wireBytes(message),
			0,
		);
		const exact = subscribed({
			maxSnapshotBytes: 10_000,
			maxPublicationBytes: size,
		});
		completeEmptySnapshot(exact);
		for (const message of messages) accept(exact, message);

		const over = subscribed({
			maxSnapshotBytes: 10_000,
			maxPublicationBytes: size - 1,
		});
		completeEmptySnapshot(over);
		expect(() => {
			for (const message of messages) accept(over, message);
		}).toThrow("publication exceeds the byte limit");
	});

	it("bounds accumulated post-snapshot backlog and releases all staging", () => {
		const reconciler = subscribed({
			maxSnapshotBytes: 10_000,
			maxPublicationBytes: 600,
		});
		accept(reconciler, snapshotStart());

		let failure: unknown;
		for (let sequence = 1; sequence <= 10; sequence += 1) {
			try {
				keyedPublication(
					reconciler,
					`p${sequence}`,
					"1",
					String(sequence),
					[upsert(ROW_A, "buffered")],
					[String(sequence)],
				);
			} catch (error) {
				failure = error;
				break;
			}
		}
		expect(failure).toMatchObject({
			message: expect.stringContaining(
				"change backlog exceeds the byte limit",
			),
		});
		expect(reconciler.stagingBytes).toBeGreaterThan(0);
		reconciler.clear();
		expect(reconciler.stagingBytes).toBe(0);
	});

	it("rejects invalid limits and message byte counts", () => {
		expect(
			() => new SnapshotPublicationReconciler({ maxSnapshotBytes: 0 }),
		).toThrow("maxSnapshotBytes must be a positive safe integer");
		const reconciler = subscribed();
		expect(() => reconciler.accept(snapshotStart(), 0)).toThrow(
			"message byte length must be a positive safe integer",
		);
	});
});

function subscribed(
	limits: Partial<ReconciliationLimits> = {},
): SnapshotPublicationReconciler {
	const reconciler = new SnapshotPublicationReconciler(limits);
	reconciler.add({
		liveId: "9",
		epoch: "1",
		firstSequence: "1",
		columnCount: 1,
		target: target(),
	});
	return reconciler;
}
