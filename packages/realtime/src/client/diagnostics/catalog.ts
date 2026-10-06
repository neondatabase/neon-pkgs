import type {
	RealtimeLogEvent,
	RealtimeLogEventDefinition,
	RealtimeLogLevel,
} from "../types.js";

export type EmittedLogLevel = Exclude<RealtimeLogLevel, "silent">;

export const EVENT_CATALOG = {
	client_closed: { level: "info", message: "Realtime client closed" },
	connection_attempt_started: {
		level: "debug",
		message: "Realtime connection attempt started",
	},
	connection_failed: {
		level: "error",
		message: "Realtime connection failed permanently",
	},
	connection_heartbeat_ping_sent: {
		level: "debug",
		message: "Realtime heartbeat ping sent",
	},
	connection_heartbeat_pong_received: {
		level: "debug",
		message: "Realtime heartbeat pong received",
	},
	connection_heartbeat_timeout: {
		level: "debug",
		message: "Realtime connection heartbeat timed out",
	},
	connection_lost: {
		level: "warn",
		message: "Realtime connection was lost; reconnecting",
	},
	connection_publication_committed: {
		level: "debug",
		message: "Realtime publication committed",
	},
	connection_ready: {
		level: "info",
		message: "Realtime connection is ready",
	},
	connection_reconnect_exhausted: {
		level: "error",
		message: "Realtime reconnect policy was exhausted",
	},
	connection_reconnect_scheduled: {
		level: "debug",
		message: "Realtime reconnect scheduled",
	},
	connection_recovered: {
		level: "info",
		message: "Realtime connection recovered",
	},
	connection_stable: {
		level: "debug",
		message: "Realtime connection is stable",
	},
	query_encryption_key_rotated: {
		level: "warn",
		message: "The query encryption key was rotated",
	},
	query_expired: { level: "warn", message: "The query expired" },
	query_refresh_callback_failed: {
		level: "warn",
		message: "Realtime query refresh callback failed; retrying",
	},
	query_refresh_callback_started: {
		level: "debug",
		message: "Realtime query refresh callback started",
	},
	query_refresh_callback_succeeded: {
		level: "debug",
		message: "Realtime query refresh callback succeeded",
	},
	query_refresh_scheduled: {
		level: "debug",
		message: "Realtime query refresh scheduled",
	},
	query_refresh_stopped: {
		level: "error",
		message: "Realtime query refresh stopped permanently",
	},
	subscription_admitted: {
		level: "debug",
		message: "Realtime subscription admitted",
	},
	subscription_failed: {
		level: "error",
		message: "Realtime subscription failed permanently",
	},
	subscription_listener_failed: {
		level: "warn",
		message: "A Realtime subscription listener failed",
	},
	subscription_live: {
		level: "info",
		message: "Realtime subscription is live",
	},
	subscription_renewal_failed: {
		level: "warn",
		message: "Realtime subscription renewal failed",
	},
	subscription_renewal_started: {
		level: "debug",
		message: "Realtime subscription renewal started",
	},
	subscription_renewed: {
		level: "info",
		message: "Realtime subscription renewed",
	},
	subscription_reset_required: {
		level: "debug",
		message: "Realtime subscription requires a new baseline sync",
	},
	subscription_row_decoding_failed: {
		level: "error",
		message: "Realtime could not decode a subscription row",
	},
	subscription_baseline_sync_completed: {
		level: "debug",
		message: "Realtime subscription baseline sync completed",
	},
	subscription_baseline_sync_started: {
		level: "debug",
		message: "Realtime subscription baseline sync started",
	},
	subscription_started: {
		level: "debug",
		message: "Realtime subscription started",
	},
	subscription_state_changed: {
		level: "debug",
		message: "Realtime subscription state changed",
	},
	subscription_unsubscribed: {
		level: "debug",
		message: "Realtime subscription unsubscribed",
	},
} as const satisfies {
	[Event in RealtimeLogEvent]: {
		readonly level: RealtimeLogEventDefinition[Event]["level"];
		readonly message: string;
	};
};

export const LEVEL_PRIORITY: Readonly<Record<EmittedLogLevel, number>> = {
	error: 0,
	warn: 1,
	info: 2,
	debug: 3,
};
