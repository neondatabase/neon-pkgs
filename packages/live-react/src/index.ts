/**
 * Consume materialized Neon Live subscriptions from React components.
 *
 * @module React
 */

export { NeonLiveProvider } from "./context.js";
export type {
	NeonLiveProviderProps,
	UseLiveQueryOptions,
	UseLiveQueryResult,
	UseLiveQueryUtils,
} from "./types.js";
export { useLiveQuery } from "./use-live-query.js";
