/** Cancel the current interval of a timer, including any later intervals. */
export type ReconnectTimer = () => void;

const MAX_TIMEOUT_MS = 2 ** 31 - 1;

export function monotonicNow(): number {
	return typeof performance === "undefined" ? Date.now() : performance.now();
}

/** Native timers cannot represent the full u32 range used by retry hints. */
export function setDeadlineTimer(
	callback: () => void,
	delayMs: number,
	clearTimer: (handle: unknown) => void = (handle) =>
		clearTimeout(handle as ReturnType<typeof setTimeout>),
): ReconnectTimer {
	const deadline = monotonicNow() + delayMs;
	let active = true;
	let handle: ReturnType<typeof setTimeout>;
	const schedule = (remainingMs: number) => {
		handle = setTimeout(
			() => {
				if (!active) return;
				const remaining = deadline - monotonicNow();
				if (remaining > 0) schedule(remaining);
				else {
					active = false;
					callback();
				}
			},
			Math.min(MAX_TIMEOUT_MS, Math.ceil(remainingMs)),
		);
	};
	schedule(delayMs);
	return () => {
		if (!active) return;
		active = false;
		clearTimer(handle);
	};
}
