import { diagnosticsForSubscription } from "@neon/live/_internal";
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

/** Utilities attached to a Realtime-backed TanStack DB collection. */
export interface RealtimeCollectionUtils extends UtilsRecord {
	/**
	 * Wait until the matching PostgreSQL transaction has entered TanStack DB's
	 * causal sync queue.
	 *
	 * @remarks
	 * This resolves for transaction IDs included in a live batch or proven
	 * visible by the last successfully applied reset snapshot. The protocol does
	 * not currently acknowledge a no-op transaction after that snapshot. It can
	 * resolve only if a later reset proves it visible; otherwise it remains
	 * pending until the optional timeout elapses or the collection is cleaned up.
	 *
	 * @param txid - PostgreSQL transaction ID as a decimal string.
	 * @param timeout - Optional maximum wait in milliseconds. By default, the
	 * promise remains pending until the transaction arrives or the collection is
	 * cleaned up.
	 * @throws If a supplied timeout elapses or the collection is cleaned up.
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
		BaseCollectionConfig<Row, Key, Schema, RealtimeCollectionUtils, void>,
		"syncMode" | "utils"
	> {
	/** Reusable low-level Realtime client. */
	readonly client: RealtimeClient;
	/** Initial query for the exact query backing this collection. */
	readonly query: SealedLiveQuery<Row>;
	/**
	 * Obtain a replacement capability for the same exact query before expiry.
	 * Transient failures are retried while the current capability remains valid.
	 */
	readonly refreshQuery?: () => Promise<SealedLiveQuery<Row>>;
	/** Derive the stable unique TanStack DB key for a row. */
	readonly getKey: (row: Row) => Key;
}

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
 * Resets and committed publication batches are applied atomically.
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
	config: RealtimeCollectionConfig<Row, Key, Schema>,
): RealtimeCollectionOptions<Row, Key, Schema> {
	const createOptions = () => createRealtimeCollectionOptions(config);
	return withCollectionConfigFactory(createOptions(), createOptions);
}

function createRealtimeCollectionOptions<
	Row extends object,
	Key extends string | number,
	Schema extends StandardSchemaV1,
>(
	config: RealtimeCollectionConfig<Row, Key, Schema>,
): RealtimeCollectionOptions<Row, Key, Schema> {
	const { client, query: initialQuery, refreshQuery, ...baseConfig } = config;
	let activeSubscription: RawLiveQuerySubscription<Row> | undefined;
	const utils: RealtimeCollectionUtils = Object.freeze({
		awaitTxId: async (txid, timeout) => {
			const subscription = activeSubscription;
			if (!subscription) {
				throw new Error("Realtime collection is not syncing");
			}
			try {
				await subscription.awaitTxId(txid, timeout);
			} catch (error) {
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

	const options: RealtimeCollectionOptions<Row, Key, Schema> = {
		...baseConfig,
		syncMode: "eager",
		utils,
		sync: {
			rowUpdateMode: "full",
			sync: ({
				begin,
				write,
				commit,
				truncate,
				markReady,
				markError,
			}) => {
				let cleaned = false;
				let rowIds = new Map<string, Key>();
				let keys = new Map<Key, string>();
				const subscription = client.subscribe(initialQuery, {
					materialize: false,
				});
				activeSubscription = subscription;

				const reportError = (error: unknown) => {
					if (!cleaned) markError(error);
				};
				const queryRefresh = new QueryRefreshController({
					query: initialQuery,
					refreshQuery,
					renewSubscription: (replacement) =>
						subscription.renew(replacement),
					onRefreshExhausted: reportError,
					diagnostics: () => diagnosticsForSubscription(subscription),
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
								if (!cleaned) onApplied?.();
							},
							(error) => reportError(error),
						);
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

						begin();
						truncate();
						for (const { row } of rows)
							write({ type: "insert", value: row });
						const receipt = commit();
						rowIds = nextRowIds;
						keys = nextKeys;
						observeReceipt(receipt, markReady);
					} catch (error) {
						reportError(error);
					}
				};

				const applyBatch = (
					changes: readonly LiveQueryChange<Row>[],
				) => {
					try {
						const nextRowIds = new Map(rowIds);
						const nextKeys = new Map(keys);
						const writes: Array<
							| { type: "insert" | "update"; value: Row }
							| { type: "delete"; key: Key }
						> = [];

						for (const change of changes) {
							if (change.type === "upsert") {
								const key = config.getKey(change.row);
								const previousKey = nextRowIds.get(
									change.rowId,
								);
								const keyOwner = nextKeys.get(key);
								if (
									keyOwner !== undefined &&
									keyOwner !== change.rowId
								) {
									throw new Error(
										`Realtime upserted an existing key: ${String(key)}`,
									);
								}
								if (previousKey === undefined) {
									nextRowIds.set(change.rowId, key);
									nextKeys.set(key, change.rowId);
									writes.push({
										type: "insert",
										value: change.row,
									});
								} else if (key !== previousKey) {
									nextKeys.delete(previousKey);
									nextKeys.set(key, change.rowId);
									nextRowIds.set(change.rowId, key);
									writes.push({
										type: "delete",
										key: previousKey,
									});
									writes.push({
										type: "insert",
										value: change.row,
									});
								} else {
									writes.push({
										type: "update",
										value: change.row,
									});
								}
							} else {
								const key = nextRowIds.get(change.rowId);
								if (key === undefined) {
									throw new Error(
										`Realtime deleted an unknown row ID: ${change.rowId}`,
									);
								}
								nextRowIds.delete(change.rowId);
								nextKeys.delete(key);
								writes.push({ type: "delete", key });
							}
						}

						begin();
						for (const message of writes) write(message);
						const receipt = commit();
						rowIds = nextRowIds;
						keys = nextKeys;
						observeReceipt(receipt);
					} catch (error) {
						reportError(error);
					}
				};

				const stateChanged = (state: LiveQueryState) => {
					if (state.status === "error") markError(state.error);
					// connecting maps to loading; live becomes ready through reset;
					// stale deliberately leaves an already-ready collection ready, and
					// closed maps to TanStack DB's normal sync cleanup.
				};

				const unsubscribeReset = subscription.onReset(installReset);
				const unsubscribeBatch = subscription.onBatch(applyBatch);
				const unsubscribeState =
					subscription.onStateChange(stateChanged);
				queryRefresh.start();

				return () => {
					cleaned = true;
					queryRefresh.stop();
					unsubscribeReset();
					unsubscribeBatch();
					unsubscribeState();
					subscription.unsubscribe();
					if (activeSubscription === subscription) {
						activeSubscription = undefined;
					}
					rowIds.clear();
					keys.clear();
				};
			},
		},
	};

	return options;
}
