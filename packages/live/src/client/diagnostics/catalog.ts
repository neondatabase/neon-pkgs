import type {
	NeonLiveLogEvent,
	NeonLiveLogEventDefinition,
	NeonLiveLogLevel,
} from "../types.js";

export type EmittedLogLevel = Exclude<NeonLiveLogLevel, "silent">;

export const EVENT_CATALOG = {
	client_closed: { level: "info", message: "Neon Live client closed" },
	connection_attempt_started: {
		level: "debug",
		message: "Neon Live connection attempt started",
	},
	connection_failed: {
		level: "error",
		message: "Neon Live connection failed permanently",
	},
	connection_heartbeat_ping_sent: {
		level: "debug",
		message: "Neon Live heartbeat ping sent",
	},
	connection_heartbeat_pong_received: {
		level: "debug",
		message: "Neon Live heartbeat pong received",
	},
	connection_heartbeat_timeout: {
		level: "debug",
		message: "Neon Live connection heartbeat timed out",
	},
	connection_lost: {
		level: "warn",
		message: "Neon Live connection was lost; reconnecting",
	},
	connection_publication_committed: {
		level: "debug",
		message: "Neon Live publication committed",
	},
	connection_ready: {
		level: "info",
		message: "Neon Live connection is ready",
	},
	connection_reconnect_exhausted: {
		level: "error",
		message: "Neon Live reconnect policy was exhausted",
	},
	connection_reconnect_scheduled: {
		level: "debug",
		message: "Neon Live reconnect scheduled",
	},
	connection_recovered: {
		level: "info",
		message: "Neon Live connection recovered",
	},
	connection_stable: {
		level: "debug",
		message: "Neon Live connection is stable",
	},
	query_encryption_key_rotated: {
		level: "warn",
		message: "The query encryption key was rotated",
	},
	query_expired: { level: "warn", message: "The query expired" },
	query_refresh_callback_failed: {
		level: "warn",
		message: "Neon Live query refresh callback failed; retrying",
	},
	query_refresh_callback_started: {
		level: "debug",
		message: "Neon Live query refresh callback started",
	},
	query_refresh_callback_succeeded: {
		level: "debug",
		message: "Neon Live query refresh callback succeeded",
	},
	query_refresh_scheduled: {
		level: "debug",
		message: "Neon Live query refresh scheduled",
	},
	query_refresh_stopped: {
		level: "error",
		message: "Neon Live query refresh stopped permanently",
	},
	subscription_admitted: {
		level: "debug",
		message: "Neon Live subscription admitted",
	},
	subscription_failed: {
		level: "error",
		message: "Neon Live subscription failed permanently",
	},
	subscription_listener_failed: {
		level: "warn",
		message: "A Neon Live subscription listener failed",
	},
	subscription_live: {
		level: "info",
		message: "Neon Live subscription is live",
	},
	subscription_renewal_failed: {
		level: "warn",
		message: "Neon Live subscription renewal failed",
	},
	subscription_renewal_started: {
		level: "debug",
		message: "Neon Live subscription renewal started",
	},
	subscription_renewed: {
		level: "info",
		message: "Neon Live subscription renewed",
	},
	subscription_reset_required: {
		level: "debug",
		message: "Neon Live subscription requires a new snapshot",
	},
	subscription_row_decoding_failed: {
		level: "error",
		message: "Neon Live could not decode a subscription row",
	},
	subscription_snapshot_completed: {
		level: "debug",
		message: "Neon Live subscription snapshot completed",
	},
	subscription_snapshot_started: {
		level: "debug",
		message: "Neon Live subscription snapshot started",
	},
	subscription_started: {
		level: "debug",
		message: "Neon Live subscription started",
	},
	subscription_state_changed: {
		level: "debug",
		message: "Neon Live subscription state changed",
	},
	subscription_unsubscribed: {
		level: "debug",
		message: "Neon Live subscription unsubscribed",
	},
} as const satisfies {
	[Event in NeonLiveLogEvent]: {
		readonly level: NeonLiveLogEventDefinition[Event]["level"];
		readonly message: string;
	};
};

export const LEVEL_PRIORITY: Readonly<Record<EmittedLogLevel, number>> = {
	error: 0,
	warn: 1,
	info: 2,
	debug: 3,
};
