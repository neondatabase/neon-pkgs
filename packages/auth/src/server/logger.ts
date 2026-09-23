/**
 * Framework-agnostic logging for Neon Auth server-side proxy and middleware.
 */

/** Supported Neon Auth log levels (`'silent'` disables all Neon Auth SDK `console` output). */
export type NeonAuthLogLevel = "error" | "warn" | "info" | "debug" | "silent";

type NeonAuthActiveLogLevel = Exclude<NeonAuthLogLevel, "silent">;

const LEVEL_RANK: Record<NeonAuthActiveLogLevel, number> = {
	error: 0,
	warn: 1,
	info: 2,
	debug: 3,
};

/**
 * Optional injectable logger. Omitted methods fall back to `console`.
 *
 * Custom implementations may receive structured fields such as `err` (the raw caught value)
 * alongside `detail` for richer sinks (Sentry, OTel).
 */
export type NeonAuthLogger = Partial<{
	error(message: string, meta?: Record<string, unknown>): void;
	warn(message: string, meta?: Record<string, unknown>): void;
	info(message: string, meta?: Record<string, unknown>): void;
	debug(message: string, meta?: Record<string, unknown>): void;
}>;

/** Resolved sink after merging defaults and level filtering (same shape as {@link NeonAuthLogger} with all methods required). */
export type ResolvedNeonAuthLogging = Required<NeonAuthLogger>;

const consoleSink: ResolvedNeonAuthLogging = {
	error: (message, meta) => {
		if (meta && Object.keys(meta).length > 0) console.error(message, meta);
		else console.error(message);
	},
	warn: (message, meta) => {
		if (meta && Object.keys(meta).length > 0) console.warn(message, meta);
		else console.warn(message);
	},
	info: (message, meta) => {
		if (meta && Object.keys(meta).length > 0) console.info(message, meta);
		else console.info(message);
	},
	debug: (message, meta) => {
		if (meta && Object.keys(meta).length > 0) console.debug(message, meta);
		else console.debug(message);
	},
};

function wrapWithLevel(
	level: NeonAuthActiveLogLevel,
	logger: ResolvedNeonAuthLogging,
): ResolvedNeonAuthLogging {
	const minRank = LEVEL_RANK[level];

	const gate = (
		messageLevel: NeonAuthActiveLogLevel,
		fn: (message: string, meta?: Record<string, unknown>) => void,
	) => {
		return (message: string, meta?: Record<string, unknown>) => {
			if (LEVEL_RANK[messageLevel] <= minRank) {
				fn(message, meta);
			}
		};
	};

	return {
		error: gate("error", logger.error),
		warn: gate("warn", logger.warn),
		info: gate("info", logger.info),
		debug: gate("debug", logger.debug),
	};
}

/**
 * Logger / level options for Neon Auth server surfaces.
 *
 * When **`logLevel`** is **`'silent'`**, any **`logger`** is ignored at runtime (full mute).
 */
export type NeonAuthLoggingInput = {
	logger?: NeonAuthLogger;
	/**
	 * Minimum level for Neon Auth logs. **`'silent'`** disables all Neon Auth `console` output.
	 * @default 'warn' — emits `error` and `warn` only
	 */
	logLevel?: NeonAuthLogLevel;
};

const noopResolved: ResolvedNeonAuthLogging = {
	error: () => {},
	warn: () => {},
	info: () => {},
	debug: () => {},
};

/**
 * Merges user logger with `console`, applies {@link NeonAuthLoggingInput} level rules.
 *
 * **Opt-out:** Defaults to `warn` (structured `error` / `warn` to `console`). Set **`logLevel: 'silent'`**
 * to disable completely. Custom **`logger`** overrides `console` per level when not silent.
 */
export function resolveNeonAuthLogging(
	input?: NeonAuthLoggingInput,
): ResolvedNeonAuthLogging {
	if (input?.logLevel === "silent") {
		return noopResolved;
	}

	const level: NeonAuthActiveLogLevel = input?.logLevel ?? "warn";
	const raw = input?.logger ?? {};
	const merged: ResolvedNeonAuthLogging = {
		error: raw.error ?? consoleSink.error,
		warn: raw.warn ?? consoleSink.warn,
		info: raw.info ?? consoleSink.info,
		debug: raw.debug ?? consoleSink.debug,
	};
	return wrapWithLevel(level, merged);
}

/**
 * Internal normalizer: accept either a pre-resolved sink or a partial
 * {@link NeonAuthLogger} (e.g. forwarded from an adapter's public config) and
 * return a `ResolvedNeonAuthLogging` (or `undefined` for downstream silence).
 *
 * - `undefined`     → unchanged (downstream code uses its `?.` fallback)
 * - all-4 methods   → treated as pre-resolved; preserves caller's level gating
 * - partial methods → merged with `console` defaults at the default `'warn'`
 *                     level (consistent with `createNeonAuth` defaults)
 *
 * Added for #161 review feedback (Andras FIX 3, DX): adapters that forward
 * `log?: NeonAuthLogger` directly into `handleAuthProxyRequest` would
 * otherwise fail TS2322 because `AuthProxyConfig.log` was typed as
 * `Required<NeonAuthLogger>`.
 *
 * @internal
 */
export function resolveLog(
	log: ResolvedNeonAuthLogging | NeonAuthLogger | undefined,
): ResolvedNeonAuthLogging | undefined {
	if (!log) return undefined;
	if (log.error && log.warn && log.info && log.debug) {
		// Pre-resolved sink: keep as-is so existing level gating is preserved.
		return log as ResolvedNeonAuthLogging;
	}
	return resolveNeonAuthLogging({ logger: log });
}
