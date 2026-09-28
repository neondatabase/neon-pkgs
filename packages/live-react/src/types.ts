import type {
	LiveQueryAuthorization,
	LiveQuerySnapshot,
	MaterializedLiveQuerySubscription,
	NeonLiveClient,
} from "@neon/live/client";
import type { ReactNode } from "react";

/** Props accepted by {@link NeonLiveProvider}. */
export interface NeonLiveProviderProps {
	/** Shared browser client made available to descendant hooks. */
	readonly client: NeonLiveClient;
	/** React subtree that may call {@link useLiveQuery}. */
	readonly children: ReactNode;
}

/**
 * Options for {@link useLiveQuery}.
 *
 * @typeParam Row - Row produced by the authorized query.
 */
export interface UseLiveQueryOptions<Row> {
	/** Server-rendered or otherwise preloaded rows exposed initially as stale. */
	readonly initialData?: readonly Row[];
	/**
	 * Obtain a replacement capability for the same exact query before expiry.
	 * Transient failures are retried while the current capability remains valid.
	 */
	readonly refreshAuthorization?: () => Promise<LiveQueryAuthorization<Row>>;
}

/**
 * Stable imperative access to the hook's underlying materialized subscription.
 *
 * Cleanup remains owned by React, so `unsubscribe()` is intentionally omitted.
 *
 * @typeParam Row - Row produced by the authorized query.
 */
export type UseLiveQueryUtils<Row> = Omit<
	MaterializedLiveQuerySubscription<Row>,
	"unsubscribe"
>;

/**
 * React-facing snapshot and lower-level utilities returned by `useLiveQuery()`.
 *
 * @typeParam Row - Row produced by the authorized query.
 */
export type UseLiveQueryResult<Row> = LiveQuerySnapshot<Row> & {
	/** Stable imperative access to state, renewal, and event listeners. */
	readonly utils: UseLiveQueryUtils<Row>;
};
