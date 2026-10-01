import type {
	NeonLiveLogEntry,
	NeonLiveLogEvent,
	NeonLiveLogger,
	NeonLiveLogLevel,
} from "./types.js";

type EmittedLogLevel = Exclude<NeonLiveLogLevel, "silent">;

export type NeonLiveLogMetadata = Omit<
	NeonLiveLogEntry,
	"event" | "level" | "message" | "timestamp"
>;

export interface NeonLiveDiagnostics {
	log(
		level: EmittedLogLevel,
		event: NeonLiveLogEvent,
		message: string,
		metadata?: NeonLiveLogMetadata,
	): void;
	nextSubscriptionId(): string;
}

export interface NeonLiveSubscriptionDiagnostics {
	readonly diagnostics: NeonLiveDiagnostics;
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
	NeonLiveSubscriptionDiagnostics
>();

export function createNeonLiveDiagnostics(options: {
	readonly logLevel?: NeonLiveLogLevel;
	readonly logger?: NeonLiveLogger;
}): NeonLiveDiagnostics {
	const level = options.logLevel ?? "silent";
	if (!(level === "silent" || level in LEVEL_PRIORITY)) {
		throw new TypeError(`Invalid Neon Live log level: ${String(level)}`);
	}
	if (options.logger !== undefined && typeof options.logger !== "function") {
		throw new TypeError("Neon Live logger must be a function");
	}
	const logger = options.logger ?? logToConsole;
	let subscriptionId = 0;
	return Object.freeze({
		log(
			entryLevel: EmittedLogLevel,
			event: NeonLiveLogEvent,
			message: string,
			metadata: NeonLiveLogMetadata = {},
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
	context: NeonLiveSubscriptionDiagnostics,
): void {
	subscriptionDiagnostics.set(subscription, context);
}

/** @internal Used by first-party integrations to share subscription context. */
export function diagnosticsForSubscription(
	subscription: object,
): NeonLiveSubscriptionDiagnostics | undefined {
	return subscriptionDiagnostics.get(subscription);
}

function logToConsole(entry: NeonLiveLogEntry): void {
	if (typeof console === "undefined") return;
	const method = console[entry.level] ?? console.log;
	method.call(console, entry);
}
