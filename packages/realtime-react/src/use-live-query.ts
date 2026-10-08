import type { SealedLiveQuery } from "@neon/realtime/client";
import { useContext, useEffect, useMemo, useSyncExternalStore } from "react";
import { RealtimeContext } from "./context.js";
import { ReactLiveQueryStore } from "./live-query-store.js";
import type { UseLiveQueryOptions, UseLiveQueryResult } from "./types.js";

/**
 * Subscribe to a sealed query and expose its materialized snapshot to
 * React. The hook owns subscription cleanup.
 *
 * @typeParam Row - Row inferred from the query.
 * @param query - Capability obtained from the application backend.
 * @param options - Optional preloaded rows and capability-refresh callback.
 * @returns The current rows and lifecycle state plus stable subscription
 * utilities.
 * @throws If used outside a {@link RealtimeProvider}.
 */
export function useLiveQuery<Row>(
	query: SealedLiveQuery<Row>,
	options: UseLiveQueryOptions<Row>,
): UseLiveQueryResult<Row>;
export function useLiveQuery<Row>(
	query: Row extends readonly unknown[] ? never : SealedLiveQuery<Row>,
	options?: UseLiveQueryOptions<Row>,
): UseLiveQueryResult<Row>;
export function useLiveQuery<Row>(
	query: SealedLiveQuery<Row>,
	options: UseLiveQueryOptions<Row> = {} as UseLiveQueryOptions<Row>,
): UseLiveQueryResult<Row> {
	const client = useContext(RealtimeContext);
	if (!client) throw new Error("useLiveQuery requires a RealtimeProvider");

	// A new query prop represents a new logical query. Callback changes
	// update the existing store and do not restart its subscription.
	// biome-ignore lint/correctness/useExhaustiveDependencies: initialData only seeds a new logical query; changing it must not restart an active subscription.
	const store = useMemo(
		() => new ReactLiveQueryStore(client, query, options),
		[client, query, options.rowMode],
	);
	useEffect(() => {
		store.setRefreshCallback(options.refreshQuery);
		return () => store.setRefreshCallback(undefined);
	}, [store, options.refreshQuery]);
	const snapshot = useSyncExternalStore(
		store.subscribe,
		store.getHookSnapshot,
		store.getServerSnapshot,
	);

	return useMemo(
		() => Object.freeze({ ...snapshot, utils: store.utils }),
		[snapshot, store],
	);
}
