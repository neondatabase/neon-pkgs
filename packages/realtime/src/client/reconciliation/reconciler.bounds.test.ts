import { describe, expect, it } from "vitest";

import {
	BaselineSyncPublicationReconciler,
	type ReconciliationLimits,
} from "./reconciler.js";
import {
	accept,
	baselineSyncEnd,
	baselineSyncStart,
	completeEmptyBaselineSync,
	keyedPublication,
	publicationMessages,
	ROW_A,
	target,
	upsert,
	wireBytes,
} from "./reconciler.test-helpers.js";

describe("reconciliation resource bounds", () => {
	it("does not cap baseline-sync bytes", () => {
		const reconciler = subscribed({ maxPublicationBytes: 10_000 });

		expect(() => {
			reconciler.accept(baselineSyncStart(), 16 * 1024 * 1024 + 1);
			accept(reconciler, baselineSyncEnd(0));
		}).not.toThrow();
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
			maxPublicationBytes: size,
		});
		completeEmptyBaselineSync(exact);
		for (const message of messages) accept(exact, message);

		const over = subscribed({
			maxPublicationBytes: size - 1,
		});
		completeEmptyBaselineSync(over);
		expect(() => {
			for (const message of messages) accept(over, message);
		}).toThrow("publication exceeds the byte limit");
	});

	it("bounds accumulated post-baseline-sync backlog and releases all staging", () => {
		const reconciler = subscribed({
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
					maxPublicationBytes: 0,
				}),
		).toThrow("maxPublicationBytes must be a positive safe integer");
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
