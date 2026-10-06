import type { RealtimeLogEntry, RealtimeLogger } from "../types.js";

export function createDiagnosticDispatcher(
	logger: RealtimeLogger,
): (entry: RealtimeLogEntry) => void {
	const entries: RealtimeLogEntry[] = [];
	let scheduled = false;
	return (entry) => {
		entries.push(entry);
		if (scheduled) return;
		scheduled = true;
		scheduleMicrotask(() => {
			scheduled = false;
			for (const queued of entries.splice(0)) {
				try {
					const result = (
						logger as (entry: RealtimeLogEntry) => unknown
					)(queued);
					if (isPromiseLike(result)) {
						void Promise.resolve(result).catch(ignoreLoggerFailure);
					}
				} catch {
					// Application logging must never interrupt live-query delivery.
				}
			}
		});
	};
}

const ignoreLoggerFailure = (): void => undefined;

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
	return (typeof value === "object" && value !== null) ||
		typeof value === "function"
		? typeof (value as { readonly then?: unknown }).then === "function"
		: false;
}

export function logToConsole(entry: RealtimeLogEntry): void {
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
