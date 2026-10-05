import { describe, expect, it } from "vitest";

import {
	BaselineSyncPublicationReconciler,
	type ReconciliationLimits,
} from "./reconciler.js";
import {
	accept,
	baselineSyncBatch,
	baselineSyncEnd,
	baselineSyncStart,
	completeEmptyBaselineSync,
	keyedPublication,
	publicationMessages,
	ROW_A,
	row,
	target,
	upsert,
	wireBytes,
} from "./reconciler.test-helpers.js";

describe("reconciliation resource bounds", () => {
	it("counts every baseline-sync frame against an exact UTF-8 byte limit", () => {
		const messages = [
			baselineSyncStart(),
			baselineSyncBatch(0, [row(ROW_A, "é")]),
			baselineSyncEnd(1),
		];
		const size = messages.reduce(
			(total, message) => total + wireBytes(message),
			0,
		);

		const exact = subscribed({
			maxBaselineSyncBytes: size,
			maxPublicationBytes: 10_000,
		});
		for (const message of messages) accept(exact, message);

		const over = subscribed({
			maxBaselineSyncBytes: size - 1,
			maxPublicationBytes: 10_000,
		});
		expect(() => {
			for (const message of messages) accept(over, message);
		}).toThrow("baseline sync exceeds the byte limit");
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
			maxBaselineSyncBytes: 10_000,
			maxPublicationBytes: size,
		});
		completeEmptyBaselineSync(exact);
		for (const message of messages) accept(exact, message);

		const over = subscribed({
			maxBaselineSyncBytes: 10_000,
			maxPublicationBytes: size - 1,
		});
		completeEmptyBaselineSync(over);
		expect(() => {
			for (const message of messages) accept(over, message);
		}).toThrow("publication exceeds the byte limit");
	});

	it("bounds accumulated post-baseline-sync backlog and releases all staging", () => {
		const reconciler = subscribed({
			maxBaselineSyncBytes: 10_000,
			maxPublicationBytes: 600,
		});
		accept(reconciler, baselineSyncStart());

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
			() =>
				new BaselineSyncPublicationReconciler({
					maxBaselineSyncBytes: 0,
				}),
		).toThrow("maxBaselineSyncBytes must be a positive safe integer");
		const reconciler = subscribed();
		expect(() => reconciler.accept(baselineSyncStart(), 0)).toThrow(
			"message byte length must be a positive safe integer",
		);
	});
});

function subscribed(
	limits: Partial<ReconciliationLimits> = {},
): BaselineSyncPublicationReconciler {
	const reconciler = new BaselineSyncPublicationReconciler(limits);
	reconciler.add({
		liveId: "9",
		epoch: "1",
		firstSequence: "1",
		columnCount: 1,
		target: target(),
	});
	return reconciler;
}
