import type { SealedLiveQuery } from "@neon/realtime/client";
import {
	useContext,
	useEffect,
	useMemo,
	useRef,
	useSyncExternalStore,
} from "react";
import { RealtimeContext } from "./context.js";
import {
	idleLiveQueryStore,
	type LiveQueryStore,
	ReactLiveQueryStore,
} from "./live-query-store.js";
import type { NoInferCompat } from "./no-infer.js";
import type { UseLiveQueryOptions, UseLiveQueryResult } from "./types.js";

/**
 * Subscribe to a sealed query and expose its materialized snapshot to
 * React. The hook owns subscription cleanup.
 *
 * Pass `null` to skip the query: no subscription is opened, and the hook
 * returns a stable idle result with status `closed` and no rows.
 *
 * @typeParam Row - Row inferred from the query.
 * @param query - Capability obtained from the application backend, or `null`
 * to skip.
 * @param options - Optional preloaded rows, capability-refresh callback, and
 * `keepPreviousData`.
 * @returns The current rows and lifecycle state plus stable subscription
 * utilities.
 * @throws If used outside a {@link RealtimeProvider}.
 */
export function useLiveQuery<Row>(
	query: SealedLiveQuery<Row> | null,
	options: UseLiveQueryOptions<NoInferCompat<Row>> = {},
): UseLiveQueryResult<Row> {
	const client = useContext(RealtimeContext);
	if (!client) throw new Error("useLiveQuery requires a RealtimeProvider");

	// A new query prop represents a new logical query. Callback changes
	// update the existing store and do not restart its subscription.
	// biome-ignore lint/correctness/useExhaustiveDependencies: initialData only seeds a new logical query; changing it must not restart an active subscription.
	const store: LiveQueryStore<Row> = useMemo(
		() =>
			query === null
				? idleLiveQueryStore<Row>()
				: new ReactLiveQueryStore(client, query, options.initialData),
		[client, query],
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

	// The rows of the last committed render that had rows of its own. It is
	// written after commit, so a render React discards never becomes the
	// placeholder for the next query.
	const committedData = useRef<readonly Row[] | undefined>(undefined);
	useEffect(() => {
		if (snapshot.data !== undefined) committedData.current = snapshot.data;
	}, [snapshot.data]);
	const placeholderData =
		options.keepPreviousData === true && snapshot.data === undefined
			? committedData.current
			: undefined;

	return useMemo(
		() =>
			Object.freeze({
				...snapshot,
				data: placeholderData ?? snapshot.data,
				isPlaceholderData: placeholderData !== undefined,
				utils: store.utils,
			}),
		[snapshot, placeholderData, store],
	);
}
