import {
	type LiveQueryChange,
	type LiveQueryState,
	QueryRefreshController,
	type RawLiveQueryRow,
	type RawLiveQuerySubscription,
	type RealtimeClient,
	type SealedLiveQuery,
} from "@neon/realtime/client";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import type {
	BaseCollectionConfig,
	CollectionConfig,
	SyncAppliedReceipt,
	UtilsRecord,
} from "@tanstack/db";
import { withCollectionConfigFactory } from "@tanstack/db";
import { planBatch } from "./batch.js";
import type { NoInferCompat } from "./no-infer.js";

/** Utilities attached to a Realtime-backed TanStack DB collection. */
export interface RealtimeCollectionUtils extends UtilsRecord {
	/**
	 * Wait until this query has processed a known committed PostgreSQL transaction.
	 * Covered row changes enter TanStack DB's causal sync queue before this resolves.
	 *
	 * @remarks
	 * This does not determine whether a transaction committed, so pass only IDs
	 * from transactions known to have committed.
	 *
	 * Before the collection starts syncing, this waits for it to start. It does
	 * not start synchronization itself. Cleanup before synchronization starts
	 * has no active run to cancel, so the wait continues into the next run.
	 *
	 * @param txid - PostgreSQL transaction ID as a decimal string.
	 * @param timeout - Optional maximum wait in milliseconds, including any wait
	 * for synchronization to start. By default, the promise remains pending
	 * until the transaction arrives, synchronization stops terminally, or an
	 * active synchronization run is cleaned up.
	 * @throws If the transaction ID or timeout is invalid, a supplied timeout
	 * elapses, synchronization stops terminally, or an active synchronization
	 * run is cleaned up.
	 */
	awaitTxId(txid: string, timeout?: number): Promise<boolean>;
}

/**
 * Configuration for a Realtime-backed TanStack DB collection.
 *
 * The adapter owns `sync`, uses eager synchronization, and supplies its own
 * collection utilities.
 *
 * @typeParam Row - Object row synchronized into the collection.
 * @typeParam Key - Stable key returned by `getKey`.
 * @typeParam Schema - Optional Standard Schema used by TanStack DB.
 */
export interface RealtimeCollectionConfig<
	Row extends object,
	Key extends string | number = string | number,
	Schema extends StandardSchemaV1 = never,
> extends Omit<
		BaseCollectionConfig<Row, Key, Schema, RealtimeCollectionUtils>,
		"syncMode" | "utils"
	> {
	/** Reusable low-level Realtime client. */
	readonly client: RealtimeClient;
	/** Initial query for the exact query backing this collection. */
	readonly query: SealedLiveQuery<Row>;
	/**
	 * Obtain a replacement capability for the same exact query before expiry.
	 * Transient failures are retried while the current capability remains valid.
	 * A collection that restarts or reloads subscribes with the newest
	 * capability this returned, and calls it straight away if that one has
	 * expired.
	 */
	readonly refreshQuery?: () => Promise<SealedLiveQuery<Row>>;
	/** Derive the stable unique TanStack DB key for a row. */
	readonly getKey: (row: Row) => Key;
}

/** Configuration that acquires its first capability when a sync run starts. */
export type LazyRealtimeCollectionConfig<
	Row extends object,
	Key extends string | number = string | number,
	Schema extends StandardSchemaV1 = never,
> = Omit<RealtimeCollectionConfig<Row, Key, Schema>, "query"> & {
	readonly query?: never;
	/**
	 * Obtain the initial capability for this collection. A stopped sync run
	 * aborts the signal and ignores a capability returned afterward.
	 */
	readonly initialQuery: (
		signal: AbortSignal,
	) => Promise<SealedLiveQuery<Row>>;
};

type RealtimeCollectionInput<
	Row extends object,
	Key extends string | number,
	Schema extends StandardSchemaV1,
> =
	| (RealtimeCollectionConfig<Row, Key, Schema> & {
			readonly initialQuery?: never;
	  })
	| LazyRealtimeCollectionConfig<Row, Key, Schema>;

/**
 * TanStack DB collection options produced by {@link realtimeCollectionOptions}.
 *
 * @typeParam Row - Object row synchronized into the collection.
 * @typeParam Key - Stable key for a collection row.
 * @typeParam Schema - Optional Standard Schema used by TanStack DB.
 */
export type RealtimeCollectionOptions<
	Row extends object,
	Key extends string | number,
	Schema extends StandardSchemaV1,
> = Omit<
	CollectionConfig<Row, Key, Schema, RealtimeCollectionUtils>,
	"utils"
> & {
	/** Realtime-specific transaction-confirmation utility. */
	readonly utils: RealtimeCollectionUtils;
};

/**
 * Create TanStack DB collection options backed by a raw live-query subscription.
 * Complete-row replacements and committed change batches are applied atomically.
 * This is an unordered keyed collection: move operations do not change membership
 * or values and are ignored. Use core materialized subscriptions for server order.
 *
 * @typeParam Row - Object row synchronized into the collection.
 * @typeParam Key - Stable key returned by `getKey`.
 * @typeParam Schema - Optional Standard Schema used by TanStack DB.
 * @param config - Live-query subscription settings and ordinary TanStack DB
 * collection options.
 * @returns Collection options to pass to TanStack DB's `createCollection()`.
 */
export function realtimeCollectionOptions<
	Row extends object,
	Key extends string | number = string | number,
	Schema extends StandardSchemaV1 = never,
>(
	// Infer rows from the query, then check collection options against that type.
	config: RealtimeCollectionInput<NoInferCompat<Row>, Key, Schema> &
		(
			| { readonly query: SealedLiveQuery<Row> }
			| {
					readonly initialQuery: (
						signal: AbortSignal,
					) => Promise<SealedLiveQuery<Row>>;
			  }
		),
): RealtimeCollectionOptions<Row, Key, Schema> {
	const createOptions = () => createRealtimeCollectionOptions(config);
	return withCollectionConfigFactory(createOptions(), createOptions);
}

/** How a sync run started: subscribed, or failed while subscribing. */
type SyncStart<Row> =
	| { readonly subscription: RawLiveQuerySubscription<Row> }
	| { readonly error: unknown };

function monotonicNow(): number {
	return typeof performance === "undefined" ? Date.now() : performance.now();
}

function validateTransactionWait(
	txid: string,
	timeout: number | undefined,
): string {
	if (typeof txid !== "string" || !/^\d+$/.test(txid)) {
		throw new Error("Live-query transaction ID must be a decimal string");
	}
	const parsed = BigInt(txid);
	if (parsed > 18_446_744_073_709_551_615n) {
		throw new Error("Live-query transaction ID exceeds uint64");
	}
	if (timeout !== undefined && (!Number.isFinite(timeout) || timeout < 0)) {
		throw new Error(
			"Live-query transaction timeout must be a non-negative number",
		);
	}
	return parsed.toString();
}

function createRealtimeCollectionOptions<
	Row extends object,
	Key extends string | number,
	Schema extends StandardSchemaV1,
>(
	config: RealtimeCollectionInput<Row, Key, Schema>,
): RealtimeCollectionOptions<Row, Key, Schema> {
	const { client, query, initialQuery, refreshQuery, ...baseConfig } = config;
	// The newest capability this collection has obtained. A restarted or
	// reloaded sync run subscribes with it rather than with the initial query,
	// which has often expired by then.
	let latestQuery = query;
	let activeSubscription: RawLiveQuerySubscription<Row> | undefined;
	let inactiveSubscriptionFailure: { readonly error: unknown } | undefined;
	const terminalSubscriptionFailures = new WeakMap<
		RawLiveQuerySubscription<Row>,
		{ readonly error: unknown }
	>();
	// awaitTxId calls made before the collection started syncing.
	const syncStartWaiters = new Set<(start: SyncStart<Row>) => void>();
	const settleSyncStartWaiters = (start: SyncStart<Row>) => {
		const waiters = [...syncStartWaiters];
		syncStartWaiters.clear();
		for (const waiter of waiters) waiter(start);
	};
	const waitForSyncStart = (txid: string, timeout: number | undefined) =>
		new Promise<RawLiveQuerySubscription<Row>>((resolve, reject) => {
			const timer =
				timeout === undefined
					? undefined
					: setTimeout(() => {
							syncStartWaiters.delete(waiter);
							reject(
								new Error(
									`Timed out waiting for live-query transaction ${txid}`,
								),
							);
						}, timeout);
			const waiter = (start: SyncStart<Row>) => {
				clearTimeout(timer);
				if ("subscription" in start) resolve(start.subscription);
				else reject(start.error);
			};
			syncStartWaiters.add(waiter);
		});
	const utils: RealtimeCollectionUtils = Object.freeze({
		awaitTxId: async (txid, timeout) => {
			const normalizedTxid = validateTransactionWait(txid, timeout);
			let subscription = activeSubscription;
			let remaining = timeout;
			if (!subscription) {
				if (inactiveSubscriptionFailure) {
					throw inactiveSubscriptionFailure.error;
				}
				const waitStarted = monotonicNow();
				subscription = await waitForSyncStart(normalizedTxid, timeout);
				if (timeout !== undefined) {
					remaining = Math.max(
						0,
						timeout - (monotonicNow() - waitStarted),
					);
				}
			}
			try {
				await subscription.awaitTxId(normalizedTxid, remaining);
			} catch (error) {
				const terminalFailure =
					terminalSubscriptionFailures.get(subscription);
				if (terminalFailure) throw terminalFailure.error;
				if (activeSubscription !== subscription) {
					throw new Error("Realtime collection was cleaned up", {
						cause: error,
					});
				}
				throw error;
			}
			return true;
		},
	});

	const options = {
		...baseConfig,
		syncMode: "eager",
		utils,
		sync: {
			rowUpdateMode: "full",
			sync: ({
				begin,
				write,
				commit,
				markReady,
				reportError,
				reportHealthy,
				fail,
			}) => {
				const sealed = latestQuery;
				if (!sealed)
					throw new Error("Realtime sync requires a sealed query");
				let cleaned = false;
				let stopped = false;
				let ready = false;
				let detached = false;
				let interrupted:
					| { readonly error: Error; reported: boolean }
					| undefined;
				let rowIds = new Map<string, Key>();
				let keys = new Map<Key, string>();
				let subscription: RawLiveQuerySubscription<Row>;
				try {
					subscription = client.subscribe(sealed, {
						materialize: false,
					});
				} catch (error) {
					const failure = { error };
					inactiveSubscriptionFailure = failure;
					settleSyncStartWaiters(failure);
					fail(error);
					return () => {
						if (inactiveSubscriptionFailure === failure) {
							inactiveSubscriptionFailure = undefined;
						}
					};
				}
				activeSubscription = subscription;
				inactiveSubscriptionFailure = undefined;
				let unsubscribeUpdate: () => void = () => undefined;
				let unsubscribeState: () => void = () => undefined;
				let queryRefresh: QueryRefreshController<Row> | undefined;

				const detach = () => {
					if (detached) return;
					detached = true;
					latestQuery = queryRefresh?.currentQuery() ?? latestQuery;
					queryRefresh?.stop();
					unsubscribeUpdate();
					unsubscribeState();
					subscription.unsubscribe();
					if (activeSubscription === subscription) {
						activeSubscription = undefined;
					}
				};
				const stop = (error: unknown) => {
					if (cleaned || stopped) return;
					stopped = true;
					const terminalFailure = { error };
					terminalSubscriptionFailures.set(
						subscription,
						terminalFailure,
					);
					if (activeSubscription === subscription) {
						inactiveSubscriptionFailure = terminalFailure;
					}
					detach();
					rowIds.clear();
					keys.clear();
					fail(error);
				};
				queryRefresh = new QueryRefreshController({
					query: sealed,
					refreshQuery,
					renewSubscription: (replacement) =>
						subscription.renew(replacement),
					onRefreshExhausted: stop,
					subscription,
				});
				const observeReceipt = (
					receipt: SyncAppliedReceipt,
					onApplied?: () => void,
				) => {
					if (receipt === true) {
						onApplied?.();
					} else {
						void receipt.then(
							() => {
								if (!cleaned && !stopped) onApplied?.();
							},
							(error) => stop(error),
						);
					}
				};
				const reportRecovered = () => {
					if (!interrupted) return;
					const recovered = interrupted;
					interrupted = undefined;
					if (ready && recovered.reported) {
						reportHealthy(recovered.error);
					}
				};
				const markSynchronized = () => {
					if (!ready) {
						ready = true;
						markReady();
					}
					if (interrupted && !interrupted.reported) {
						reportError(interrupted.error);
						interrupted.reported = true;
					}
				};
				const reportInterruption = () => {
					if (interrupted) return;
					const error = new Error(
						"Realtime synchronization is interrupted while automatic recovery continues",
					);
					error.name = "RealtimeSyncInterruptedError";
					interrupted = { error, reported: false };
					if (ready) {
						reportError(error);
						interrupted.reported = true;
					}
				};

				const installReset = (
					rows: readonly RawLiveQueryRow<Row>[],
				) => {
					try {
						const nextRowIds = new Map<string, Key>();
						const nextKeys = new Map<Key, string>();
						for (const { rowId, row } of rows) {
							const key = config.getKey(row);
							if (nextRowIds.has(rowId)) {
								throw new Error(
									`Duplicate Realtime row ID: ${rowId}`,
								);
							}
							if (nextKeys.has(key)) {
								throw new Error(
									`Duplicate TanStack collection key: ${String(key)}`,
								);
							}
							nextRowIds.set(rowId, key);
							nextKeys.set(key, rowId);
						}

						begin({ snapshot: true });
						for (const { row } of rows)
							write({ type: "insert", value: row });
						const receipt = commit();
						rowIds = nextRowIds;
						keys = nextKeys;
						observeReceipt(receipt, markSynchronized);
					} catch (error) {
						stop(error);
					}
				};

				const applyBatch = (
					changes: readonly LiveQueryChange<Row>[],
				) => {
					try {
						const batch = planBatch(
							rowIds,
							keys,
							changes,
							config.getKey,
						);
						begin();
						for (const message of batch.writes) write(message);
						const receipt = commit();
						batch.commit();
						observeReceipt(receipt);
					} catch (error) {
						stop(error);
					}
				};

				const stateChanged = (state: LiveQueryState) => {
					if (state.status === "error") stop(state.error);
					else if (state.status === "closed") {
						const error = new Error("Realtime subscription closed");
						error.name = "RealtimeSubscriptionClosedError";
						stop(error);
					} else if (
						state.status === "connecting" ||
						state.status === "stale"
					)
						reportInterruption();
					else if (state.status === "live") reportRecovered();
					// Initial connecting maps to loading. Normal cleanup detaches this
					// listener before closing, so an observed closed state is terminal.
				};

				unsubscribeUpdate = subscription.onUpdate((update) => {
					if (update.type === "rows") installReset(update.rows);
					else applyBatch(update.changes);
				});
				unsubscribeState = subscription.onStateChange(stateChanged);
				const state = subscription.getState();
				if (state.status === "error" || state.status === "closed") {
					stateChanged(state);
				}
				if (!stopped) queryRefresh.start();
				const start: SyncStart<Row> = terminalSubscriptionFailures.get(
					subscription,
				) ?? { subscription };
				settleSyncStartWaiters(start);

				return () => {
					cleaned = true;
					if (
						inactiveSubscriptionFailure ===
						terminalSubscriptionFailures.get(subscription)
					) {
						inactiveSubscriptionFailure = undefined;
					}
					detach();
					rowIds.clear();
					keys.clear();
				};
			},
		},
	} satisfies RealtimeCollectionOptions<Row, Key, Schema>;

	if (!initialQuery) return options;
	return {
		...options,
		sync: {
			...options.sync,
			sync: (params) => {
				if (latestQuery) return options.sync.sync(params);

				const controller = new AbortController();
				const cleanupError = new Error(
					"Realtime collection was cleaned up",
				);
				let unsubscribe: (() => void) | undefined;
				let acquisitionFailure: { readonly error: unknown } | undefined;
				let cancelAcquisition!: (error: Error) => void;
				const canceled = new Promise<never>((_, reject) => {
					cancelAcquisition = reject;
				});
				void Promise.race([
					Promise.resolve().then(() => {
						controller.signal.throwIfAborted();
						return initialQuery(controller.signal);
					}),
					canceled,
				])
					.then((sealed) => {
						if (controller.signal.aborted) return;
						latestQuery = sealed;
						const dispose = options.sync.sync(params);
						if (controller.signal.aborted) dispose();
						else unsubscribe = dispose;
					})
					.catch((error: unknown) => {
						if (controller.signal.aborted) return;
						acquisitionFailure = { error };
						inactiveSubscriptionFailure = acquisitionFailure;
						settleSyncStartWaiters(acquisitionFailure);
						params.fail(error);
					});
				return () => {
					controller.abort(cleanupError);
					cancelAcquisition(cleanupError);
					if (unsubscribe) {
						unsubscribe();
					} else {
						if (
							inactiveSubscriptionFailure === acquisitionFailure
						) {
							inactiveSubscriptionFailure = undefined;
						}
						settleSyncStartWaiters({ error: cleanupError });
					}
				};
			},
		},
	};
}
