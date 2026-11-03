import type {
	LiveQuerySnapshot,
	MaterializedLiveQuerySubscription,
	RealtimeClient,
	SealedLiveQuery,
} from "@neon/realtime/client";
import type { ReactNode } from "react";

/** Props accepted by {@link RealtimeProvider}. */
export interface RealtimeProviderProps {
	/** Shared browser client made available to descendant hooks. */
	readonly client: RealtimeClient;
	/**
	 * React subtree that may call {@link useLiveQuery} or
	 * {@link useRealtimeClient}.
	 */
	readonly children: ReactNode;
}

/**
 * Options for {@link useLiveQuery}.
 *
 * @typeParam Row - Row produced by the sealed query.
 */
export interface UseLiveQueryOptions<Row> {
	/**
	 * Decoded rows exposed immediately, including during server rendering.
	 * Restore values changed by transport serialization before passing them here.
	 * Ignored while the query is `null`.
	 */
	readonly initialData?: readonly Row[];
	/**
	 * Obtain a replacement capability for the same exact query before expiry.
	 * Transient failures are retried while the current capability remains valid.
	 * Ignored while the query is `null`.
	 */
	readonly refreshQuery?: () => Promise<SealedLiveQuery<Row>>;
	/**
	 * Keep returning the last rows this hook rendered when the sealed query
	 * changes or becomes `null`, until the current query has rows of its own
	 * (its first result, or its `initialData`). Use it for a growing `LIMIT` or
	 * a moved date range, so the list does not empty while the next query
	 * loads. {@link UseLiveQueryResult.isPlaceholderData} is `true` while the
	 * previous rows are shown; `status` and `error` always describe the
	 * current query.
	 *
	 * @defaultValue `false`
	 */
	readonly keepPreviousData?: boolean;
}

/**
 * Stable imperative access to the hook's underlying materialized subscription.
 *
 * Cleanup remains owned by React, so `unsubscribe()` is intentionally omitted.
 * While the query is `null`, there is no subscription: `getState()` and
 * `getSnapshot()` report `closed` with no rows, listeners never run, and
 * `awaitTxId()`, `awaitRows()` and `renew()` reject.
 *
 * @typeParam Row - Row produced by the sealed query.
 */
export type UseLiveQueryUtils<Row> = Omit<
	MaterializedLiveQuerySubscription<Row>,
	"unsubscribe"
>;

/**
 * React-facing snapshot and lower-level utilities returned by `useLiveQuery()`.
 *
 * While the query is `null` the result is idle: `status` is `closed`, `error`
 * and `data` are `undefined` (unless `keepPreviousData` holds earlier rows),
 * and the same object is returned on every render.
 *
 * @typeParam Row - Row produced by the sealed query.
 */
export type UseLiveQueryResult<Row> = LiveQuerySnapshot<Row> & {
	/**
	 * `true` when `data` holds rows from an earlier query, kept by
	 * `keepPreviousData` until the current query has rows of its own.
	 */
	readonly isPlaceholderData: boolean;
	/** Stable imperative access to state, renewal, and event listeners. */
	readonly utils: UseLiveQueryUtils<Row>;
};
