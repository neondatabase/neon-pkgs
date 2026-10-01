import type {
	RealtimeLogEntry,
	RealtimeLogEvent,
	RealtimeLogger,
	RealtimeLogLevel,
} from "./types.js";

type EmittedLogLevel = Exclude<RealtimeLogLevel, "silent">;

export type RealtimeLogMetadata = Omit<
	RealtimeLogEntry,
	"event" | "level" | "message" | "timestamp"
>;

export interface RealtimeDiagnostics {
	log(
		level: EmittedLogLevel,
		event: RealtimeLogEvent,
		message: string,
		metadata?: RealtimeLogMetadata,
	): void;
	nextSubscriptionId(): string;
}

export interface RealtimeSubscriptionDiagnostics {
	readonly diagnostics: RealtimeDiagnostics;
	readonly subscriptionId: string;
}

const LEVEL_PRIORITY: Readonly<Record<EmittedLogLevel, number>> = {
	error: 0,
	warn: 1,
	info: 2,
	debug: 3,
};

const subscriptionDiagnostics = new WeakMap<
	object,
	RealtimeSubscriptionDiagnostics
>();

export function createRealtimeDiagnostics(options: {
	readonly logLevel?: RealtimeLogLevel;
	readonly logger?: RealtimeLogger;
}): RealtimeDiagnostics {
	const level = options.logLevel ?? "silent";
	if (!(level === "silent" || level in LEVEL_PRIORITY)) {
		throw new TypeError(`Invalid Realtime log level: ${String(level)}`);
	}
	if (options.logger !== undefined && typeof options.logger !== "function") {
		throw new TypeError("Realtime logger must be a function");
	}
	const logger = options.logger ?? logToConsole;
	let subscriptionId = 0;
	return Object.freeze({
		log(
			entryLevel: EmittedLogLevel,
			event: RealtimeLogEvent,
			message: string,
			metadata: RealtimeLogMetadata = {},
		): void {
			if (
				level === "silent" ||
				LEVEL_PRIORITY[entryLevel] > LEVEL_PRIORITY[level]
			)
				return;
			const entry = Object.freeze({
				...metadata,
				level: entryLevel,
				event,
				message,
				timestamp: Date.now(),
			});
			try {
				logger(entry);
			} catch {
				// Application logging must never interrupt live-query delivery.
			}
		},
		nextSubscriptionId: () => `s${++subscriptionId}`,
	});
}

export function registerSubscriptionDiagnostics(
	subscription: object,
	context: RealtimeSubscriptionDiagnostics,
): void {
	subscriptionDiagnostics.set(subscription, context);
}

/** @internal Used by first-party integrations to share subscription context. */
export function diagnosticsForSubscription(
	subscription: object,
): RealtimeSubscriptionDiagnostics | undefined {
	return subscriptionDiagnostics.get(subscription);
}

function logToConsole(entry: RealtimeLogEntry): void {
	if (typeof console === "undefined") return;
	const method = console[entry.level] ?? console.log;
	method.call(console, entry);
}
