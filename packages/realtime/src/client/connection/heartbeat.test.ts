import { describe, expect, it, vi } from "vitest";

import { defined } from "../../defined.test-helpers.js";
import { ConnectionHeartbeat, type HeartbeatOptions } from "./heartbeat.js";

describe("ConnectionHeartbeat", () => {
	it("fences callbacks left behind by retired heartbeat generations", () => {
		const timers: Array<() => void> = [];
		const sendPing = vi.fn(() => true);
		const timedOut = vi.fn();
		const heartbeat = new ConnectionHeartbeat(
			{
				idleMs: 20,
				timeoutMs: 10,
				setTimer: ((callback: () => void) => {
					timers.push(callback);
					return timers.length;
				}) as unknown as HeartbeatOptions["setTimer"],
				// Deliberately leave callbacks runnable to simulate a timer already
				// queued on the event loop when cancellation occurs.
				clearTimer: vi.fn(),
			},
			{ sendPing, timedOut },
		);

		heartbeat.start();
		heartbeat.stop();
		heartbeat.start();
		defined(timers[0])();
		expect(sendPing).not.toHaveBeenCalled();

		defined(timers[1])();
		expect(sendPing).toHaveBeenCalledOnce();
		heartbeat.received();
		defined(timers[2])();
		expect(timedOut).not.toHaveBeenCalled();
	});

	it("times out a ping that could not be sent", () => {
		const timers: Array<() => void> = [];
		// The coordinator's send() reports false when the socket isn't open.
		const sendPing = vi.fn(() => false);
		const timedOut = vi.fn();
		const heartbeat = new ConnectionHeartbeat(
			{
				idleMs: 20,
				timeoutMs: 10,
				setTimer: ((callback: () => void) => {
					timers.push(callback);
					return timers.length;
				}) as unknown as HeartbeatOptions["setTimer"],
				clearTimer: vi.fn(),
			},
			{ sendPing, timedOut },
		);

		heartbeat.start();
		defined(timers[0])();
		expect(sendPing).toHaveBeenCalledOnce();
		expect(timedOut).not.toHaveBeenCalled();
		defined(timers[1])();
		expect(timedOut).toHaveBeenCalledOnce();
	});

	it("rejects invalid timer configuration", () => {
		expect(
			() => new ConnectionHeartbeat({ idleMs: 0 }, callbacks()),
		).toThrow("heartbeat.idleMs must be a positive safe integer");
		expect(
			() =>
				new ConnectionHeartbeat({ timeoutMs: Number.NaN }, callbacks()),
		).toThrow("heartbeat.timeoutMs must be a positive safe integer");
	});
});

function callbacks(): { sendPing(): boolean; timedOut(): void } {
	return { sendPing: () => true, timedOut: () => undefined };
}
