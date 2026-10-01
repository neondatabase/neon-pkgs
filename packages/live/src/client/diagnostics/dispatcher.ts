import type { NeonLiveLogEntry, NeonLiveLogger } from "../types.js";

export function createDiagnosticDispatcher(
	logger: NeonLiveLogger,
): (entry: NeonLiveLogEntry) => void {
	const entries: NeonLiveLogEntry[] = [];
	let scheduled = false;
	return (entry) => {
		entries.push(entry);
		if (scheduled) return;
		scheduled = true;
		scheduleMicrotask(() => {
			scheduled = false;
			for (const queued of entries.splice(0)) {
				try {
					logger(queued);
				} catch {
					// Application logging must never interrupt live-query delivery.
				}
			}
		});
	};
}

export function logToConsole(entry: NeonLiveLogEntry): void {
	if (typeof console === "undefined") return;
	const method = console[entry.level] ?? console.log;
	method.call(console, entry);
}

const scheduleMicrotask =
	typeof queueMicrotask === "function"
		? queueMicrotask
		: (callback: () => void) => {
				void Promise.resolve().then(callback);
			};
