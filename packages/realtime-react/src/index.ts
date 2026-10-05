/**
 * Consume materialized live-query subscriptions from React components.
 *
 * @module React
 */

export { RealtimeProvider } from "./context.js";
export type {
	RealtimeProviderProps,
	UseLiveQueryOptions,
	UseLiveQueryResult,
	UseLiveQueryUtils,
} from "./types.js";
export { useLiveQuery } from "./use-live-query.js";
