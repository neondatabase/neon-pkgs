const DEFAULT_IDLE_MS = 20_000;
const DEFAULT_TIMEOUT_MS = 10_000;

type TimerHandle = ReturnType<typeof setTimeout>;

export interface HeartbeatOptions {
	/** How long the connection may be idle before the client probes it. */
	readonly idleMs?: number;
	/** How long the probe may go without inbound activity. */
	readonly timeoutMs?: number;
	readonly setTimer?: (callback: () => void, delayMs: number) => TimerHandle;
	readonly clearTimer?: (handle: TimerHandle) => void;
}

export interface HeartbeatCallbacks {
	sendPing(token: string): boolean;
	timedOut(): void;
}

/** Tracks application-level liveness independently of transport events. */
export class ConnectionHeartbeat {
	private readonly idleMs: number;
	private readonly timeoutMs: number;
	private readonly setTimer: (
		callback: () => void,
		delayMs: number,
	) => TimerHandle;
	private readonly clearTimer: (handle: TimerHandle) => void;
	private idleTimer?: TimerHandle;
	private timeoutTimer?: TimerHandle;
	private generation = 0;
	private nextToken = 1;
	private active = false;

	constructor(
		options: HeartbeatOptions,
		private readonly callbacks: HeartbeatCallbacks,
	) {
		this.idleMs = positiveSafeInteger(
			options.idleMs ?? DEFAULT_IDLE_MS,
			"heartbeat.idleMs",
		);
		this.timeoutMs = positiveSafeInteger(
			options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
			"heartbeat.timeoutMs",
		);
		// Browser timer functions are Web IDL methods and may reject a class
		// instance as their implicit receiver. Invoke them through closures so
		// the host supplies the correct global receiver.
		this.setTimer =
			options.setTimer ??
			((callback, delayMs) => setTimeout(callback, delayMs));
		this.clearTimer =
			options.clearTimer ?? ((handle) => clearTimeout(handle));
	}

	start(): void {
		this.active = true;
		this.armIdleTimer();
	}

	/** Any valid inbound message proves that the peer is still processing. */
	received(): void {
		if (!this.active) return;
		this.armIdleTimer();
	}

	stop(): void {
		this.active = false;
		this.clearTimers();
	}

	private armIdleTimer(): void {
		this.clearTimers();
		const generation = this.generation;
		this.idleTimer = this.setTimer(() => {
			if (!this.active || generation !== this.generation) return;
			this.idleTimer = undefined;
			const sent = this.callbacks.sendPing(`c${this.nextToken++}`);
			// A test socket, or an in-process transport, may deliver a response
			// synchronously from sendPing(). Do not arm its now-obsolete timeout.
			if (!sent || !this.active || generation !== this.generation) return;
			this.timeoutTimer = this.setTimer(() => {
				if (!this.active || generation !== this.generation) return;
				this.timeoutTimer = undefined;
				this.callbacks.timedOut();
			}, this.timeoutMs);
		}, this.idleMs);
	}

	private clearTimers(): void {
		this.generation += 1;
		if (this.idleTimer !== undefined) this.clearTimer(this.idleTimer);
		if (this.timeoutTimer !== undefined) this.clearTimer(this.timeoutTimer);
		this.idleTimer = undefined;
		this.timeoutTimer = undefined;
	}
}

function positiveSafeInteger(value: number, name: string): number {
	if (!Number.isSafeInteger(value) || value <= 0) {
		throw new RangeError(`${name} must be a positive safe integer`);
	}
	return value;
}
