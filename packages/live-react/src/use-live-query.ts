import type { LiveQueryAuthorization } from "@neon/live/client";
import { useContext, useEffect, useMemo, useSyncExternalStore } from "react";
import { NeonLiveContext } from "./context.js";
import { ReactLiveQueryStore } from "./live-query-store.js";
import type { UseLiveQueryOptions, UseLiveQueryResult } from "./types.js";

/**
 * Subscribe to an authorized query and expose its materialized snapshot to
 * React. The hook owns subscription cleanup.
 *
 * @typeParam Row - Row inferred from the authorization.
 * @param authorization - Capability obtained from the application backend.
 * @param options - Optional preloaded rows and capability-refresh callback.
 * @returns The current rows and lifecycle state plus stable subscription
 * utilities.
 * @throws If used outside a {@link NeonLiveProvider}.
 */
export function useLiveQuery<Row>(
	authorization: LiveQueryAuthorization<Row>,
	options: UseLiveQueryOptions<Row> = {},
): UseLiveQueryResult<Row> {
	const client = useContext(NeonLiveContext);
	if (!client) throw new Error("useLiveQuery requires a NeonLiveProvider");

	// A new authorization prop represents a new logical query. Callback changes
	// update the existing store and do not restart its subscription.
	// biome-ignore lint/correctness/useExhaustiveDependencies: initialData only seeds a new logical query; changing it must not restart an active subscription.
	const store = useMemo(
		() =>
			new ReactLiveQueryStore(client, authorization, options.initialData),
		[client, authorization],
	);
	useEffect(() => {
		store.setRefreshAuthorization(options.refreshAuthorization);
		return () => store.setRefreshAuthorization(undefined);
	}, [store, options.refreshAuthorization]);
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
