import type {
	RealtimeLogEntry,
	RealtimeLogEvent,
	RealtimeLogEventDefinition,
	RealtimeLogger,
	RealtimeLogLevel,
} from "../types.js";
import {
	type EmittedLogLevel,
	EVENT_CATALOG,
	LEVEL_PRIORITY,
} from "./catalog.js";
import { createDiagnosticDispatcher, logToConsole } from "./dispatcher.js";
import type {
	ClientEventSink,
	ConnectionEventSink,
	DiagnosticError,
	QueryRefreshEventSink,
	SubscriptionEventSink,
} from "./events.js";

const noop = (): void => undefined;

const SILENT_REFRESH_EVENTS: QueryRefreshEventSink = Object.freeze({
	scheduled: noop,
	callbackStarted: noop,
	callbackSucceeded: noop,
	callbackFailed: noop,
	stopped: noop,
});

export const SILENT_SUBSCRIPTION_EVENTS: SubscriptionEventSink = Object.freeze({
	refresh: SILENT_REFRESH_EVENTS,
	started: noop,
	admitted: noop,
	renewalStarted: noop,
	renewalFailed: noop,
	renewed: noop,
	unsubscribed: noop,
	live: noop,
	failed: noop,
	queryUnavailable: noop,
	listenerFailed: noop,
	stateChanged: noop,
	baselineSyncStarted: noop,
	baselineSyncCompleted: noop,
	resetRequired: noop,
});

const SILENT_CONNECTION_EVENTS: ConnectionEventSink = Object.freeze({
	attemptStarted: noop,
	ready: noop,
	lost: noop,
	reconnectScheduled: noop,
	reconnectExhausted: noop,
	stable: noop,
	heartbeatPingSent: noop,
	heartbeatPongReceived: noop,
	heartbeatTimedOut: noop,
	publicationCommitted: noop,
	failed: noop,
	episodeEnded: noop,
});

export const SILENT_CLIENT_EVENTS: ClientEventSink = Object.freeze({
	connection: SILENT_CONNECTION_EVENTS,
	createSubscription: () => SILENT_SUBSCRIPTION_EVENTS,
	closed: noop,
});

export function createClientEventSink(options: {
	readonly logLevel?: RealtimeLogLevel;
	readonly logger?: RealtimeLogger;
}): ClientEventSink {
	const level = options.logLevel ?? "silent";
	if (!(level === "silent" || Object.hasOwn(LEVEL_PRIORITY, level))) {
		throw new TypeError(`Invalid Realtime log level: ${String(level)}`);
	}
	if (options.logger !== undefined && typeof options.logger !== "function") {
		throw new TypeError("Realtime logger must be a function");
	}
	if (level === "silent") return SILENT_CLIENT_EVENTS;

	const dispatch = createDiagnosticDispatcher(options.logger ?? logToConsole);
	const emit = createEmitter(level, dispatch);
	let nextSubscriptionId = 0;
	let everReady = false;
	let outageStartedAt: number | undefined;
	let reconnectAttempt: number | undefined;

	const connection: ConnectionEventSink = {
		attemptStarted: () =>
			emit(
				"connection_attempt_started",
				optionalAttempt(reconnectAttempt),
			),
		ready: () => {
			const outageStart = outageStartedAt;
			if (everReady && outageStart !== undefined) {
				emit("connection_recovered", {
					...optionalAttempt(reconnectAttempt),
					durationMs: Math.max(0, Date.now() - outageStart),
				});
			} else {
				emit("connection_ready", optionalAttempt(reconnectAttempt));
			}
			everReady = true;
			outageStartedAt = undefined;
		},
		lost: (error, activeSubscriptionCount) => {
			if (outageStartedAt !== undefined) return;
			outageStartedAt = Date.now();
			const coordinatorError = isDiagnosticError(error)
				? error
				: undefined;
			emit("connection_lost", {
				activeSubscriptionCount,
				...(coordinatorError
					? {
							code: coordinatorError.code,
							retryable: coordinatorError.retryable,
						}
					: {}),
				...(error === undefined ? {} : { error }),
			});
		},
		reconnectScheduled: (attempt, delayMs) => {
			reconnectAttempt = attempt;
			emit("connection_reconnect_scheduled", { attempt, delayMs });
		},
		reconnectExhausted: (error) =>
			emit("connection_reconnect_exhausted", errorMetadata(error)),
		stable: () => {
			reconnectAttempt = undefined;
			emit("connection_stable", {});
		},
		heartbeatPingSent: () => emit("connection_heartbeat_ping_sent", {}),
		heartbeatPongReceived: () =>
			emit("connection_heartbeat_pong_received", {}),
		heartbeatTimedOut: () => emit("connection_heartbeat_timeout", {}),
		publicationCommitted: (bodyCount) =>
			emit("connection_publication_committed", { bodyCount }),
		failed: (error) => emit("connection_failed", errorMetadata(error)),
		episodeEnded: () => {
			outageStartedAt = undefined;
			reconnectAttempt = undefined;
		},
	};
	Object.freeze(connection);

	return Object.freeze({
		connection,
		createSubscription: () =>
			createSubscriptionEventSink(`s${++nextSubscriptionId}`, emit),
		closed: () => emit("client_closed", {}),
	});
}

type EventMetadata<Event extends RealtimeLogEvent> =
	RealtimeLogEventDefinition[Event]["metadata"];

type Emit = <Event extends RealtimeLogEvent>(
	event: Event,
	metadata: EventMetadata<Event>,
) => void;

function createEmitter(
	configuredLevel: EmittedLogLevel,
	dispatch: (entry: RealtimeLogEntry) => void,
): Emit {
	return <Event extends RealtimeLogEvent>(
		event: Event,
		metadata: EventMetadata<Event>,
	): void => {
		const definition = EVENT_CATALOG[event];
		if (
			LEVEL_PRIORITY[definition.level] > LEVEL_PRIORITY[configuredLevel]
		) {
			return;
		}
		const entry = Object.freeze({
			...metadata,
			level: definition.level,
			event,
			message: definition.message,
			timestamp: Date.now(),
		}) as RealtimeLogEntry;
		dispatch(entry);
	};
}

function createSubscriptionEventSink(
	subscriptionId: string,
	emit: Emit,
): SubscriptionEventSink {
	const metadata = { subscriptionId };
	const refresh: QueryRefreshEventSink = {
		scheduled: (delayMs, expiresAt) =>
			emit("query_refresh_scheduled", {
				...metadata,
				delayMs,
				expiresAt,
			}),
		callbackStarted: () => emit("query_refresh_callback_started", metadata),
		callbackSucceeded: () =>
			emit("query_refresh_callback_succeeded", metadata),
		callbackFailed: (error) =>
			emit("query_refresh_callback_failed", { ...metadata, error }),
		stopped: (error) =>
			emit("query_refresh_stopped", { ...metadata, error }),
	};
	Object.freeze(refresh);

	const subscription: SubscriptionEventSink = {
		refresh,
		started: () => emit("subscription_started", metadata),
		admitted: () => emit("subscription_admitted", metadata),
		renewalStarted: () => emit("subscription_renewal_started", metadata),
		renewalFailed: (error) =>
			emit("subscription_renewal_failed", { ...metadata, error }),
		renewed: () => emit("subscription_renewed", metadata),
		unsubscribed: () => emit("subscription_unsubscribed", metadata),
		live: () => emit("subscription_live", metadata),
		failed: (error) =>
			emit(
				error.code === "parser_error"
					? "subscription_row_decoding_failed"
					: "subscription_failed",
				{ ...metadata, ...errorMetadata(error) },
			),
		queryUnavailable: (error) =>
			emit(
				error.code === "key_retired"
					? "query_encryption_key_rotated"
					: "query_expired",
				{ ...metadata, ...errorMetadata(error) },
			),
		listenerFailed: (error) =>
			emit("subscription_listener_failed", { ...metadata, error }),
		stateChanged: (fromStatus, toStatus) =>
			emit("subscription_state_changed", {
				...metadata,
				fromStatus,
				toStatus,
			}),
		baselineSyncStarted: () => emit("subscription_baseline_sync_started", metadata),
		baselineSyncCompleted: (batchCount) =>
			emit("subscription_baseline_sync_completed", {
				...metadata,
				batchCount,
			}),
		resetRequired: () => emit("subscription_reset_required", metadata),
	};
	return Object.freeze(subscription);
}

function errorMetadata(error: DiagnosticError): {
	readonly code: string;
	readonly retryable: boolean;
	readonly error: unknown;
} {
	return { code: error.code, retryable: error.retryable, error };
}

function isDiagnosticError(error: unknown): error is DiagnosticError {
	return (
		error instanceof Error &&
		"code" in error &&
		typeof error.code === "string" &&
		"retryable" in error &&
		typeof error.retryable === "boolean"
	);
}

function optionalAttempt(attempt: number | undefined): {
	readonly attempt?: number;
} {
	return attempt === undefined ? {} : { attempt };
}
