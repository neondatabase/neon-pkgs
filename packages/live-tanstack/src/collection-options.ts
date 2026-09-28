import {
	AuthorizationRefreshController,
	type LiveQueryAuthorization,
	type LiveQueryBatchInfo,
	type LiveQueryChange,
	type LiveQueryState,
	type NeonLiveClient,
	type RawLiveQueryRow,
} from "@neon/live/client";
import type { StandardSchemaV1 } from "@standard-schema/spec";
import type {
	BaseCollectionConfig,
	CollectionConfig,
	SyncAppliedReceipt,
	UtilsRecord,
} from "@tanstack/db";
import { withCollectionConfigFactory } from "@tanstack/db";
import { TransactionTracker } from "./transaction-tracker.js";

/** Utilities attached to a Neon Live-backed TanStack DB collection. */
export interface NeonLiveCollectionUtils extends UtilsRecord {
	/**
	 * Wait until the matching PostgreSQL transaction has entered TanStack DB's
	 * causal sync queue.
	 *
	 * @param txid - PostgreSQL transaction ID as a decimal string.
	 * @param timeout - Maximum wait in milliseconds; defaults to 5 seconds.
	 * @throws If the timeout elapses or the collection is cleaned up.
	 */
	awaitTxId(txid: string, timeout?: number): Promise<boolean>;
}

/**
 * Configuration for a Neon Live-backed TanStack DB collection.
 *
 * The adapter owns `sync`, uses eager synchronization, and supplies its own
 * collection utilities.
 *
 * @typeParam Row - Object row synchronized into the collection.
 * @typeParam Key - Stable key returned by `getKey`.
 * @typeParam Schema - Optional Standard Schema used by TanStack DB.
 */
export interface NeonLiveCollectionConfig<
	Row extends object,
	Key extends string | number = string | number,
	Schema extends StandardSchemaV1 = never,
> extends Omit<
		BaseCollectionConfig<Row, Key, Schema, NeonLiveCollectionUtils, void>,
		"syncMode" | "utils"
	> {
	/** Reusable low-level Neon Live client. */
	readonly client: NeonLiveClient;
	/** Initial authorization for the exact query backing this collection. */
	readonly authorization: LiveQueryAuthorization<Row>;
	/**
	 * Obtain a replacement capability for the same exact query before expiry.
	 * Transient failures are retried while the current capability remains valid.
	 */
	readonly refreshAuthorization?: () => Promise<LiveQueryAuthorization<Row>>;
	/** Derive the stable unique TanStack DB key for a row. */
	readonly getKey: (row: Row) => Key;
}

/**
 * TanStack DB collection options produced by {@link neonLiveCollectionOptions}.
 *
 * @typeParam Row - Object row synchronized into the collection.
 * @typeParam Key - Stable key for a collection row.
 * @typeParam Schema - Optional Standard Schema used by TanStack DB.
 */
export type NeonLiveCollectionOptions<
	Row extends object,
	Key extends string | number,
	Schema extends StandardSchemaV1,
> = Omit<
	CollectionConfig<Row, Key, Schema, NeonLiveCollectionUtils>,
	"utils"
> & {
	/** Neon Live-specific transaction-confirmation utility. */
	readonly utils: NeonLiveCollectionUtils;
};

/**
 * Create TanStack DB collection options backed by a raw Neon Live subscription.
 * Resets and committed publication batches are applied atomically.
 *
 * @typeParam Row - Object row synchronized into the collection.
 * @typeParam Key - Stable key returned by `getKey`.
 * @typeParam Schema - Optional Standard Schema used by TanStack DB.
 * @param config - Neon Live subscription settings and ordinary TanStack DB
 * collection options.
 * @returns Collection options to pass to TanStack DB's `createCollection()`.
 */
export function neonLiveCollectionOptions<
	Row extends object,
	Key extends string | number = string | number,
	Schema extends StandardSchemaV1 = never,
>(
	config: NeonLiveCollectionConfig<Row, Key, Schema>,
): NeonLiveCollectionOptions<Row, Key, Schema> {
	const createOptions = () => createNeonLiveCollectionOptions(config);
	return withCollectionConfigFactory(createOptions(), createOptions);
}

function createNeonLiveCollectionOptions<
	Row extends object,
	Key extends string | number,
	Schema extends StandardSchemaV1,
>(
	config: NeonLiveCollectionConfig<Row, Key, Schema>,
): NeonLiveCollectionOptions<Row, Key, Schema> {
	const {
		client,
		authorization: initialAuthorization,
		refreshAuthorization,
		...baseConfig
	} = config;
	const transactions = new TransactionTracker();
	const utils: NeonLiveCollectionUtils = Object.freeze({
		awaitTxId: transactions.wait,
	});

	const options: NeonLiveCollectionOptions<Row, Key, Schema> = {
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
				transactions.open();
				let cleaned = false;
				let rowIds = new Map<string, Key>();
				let keys = new Map<Key, string>();
				const subscription = client.subscribe(initialAuthorization, {
					materialize: false,
				});

				const reportError = (error: unknown) => {
					if (!cleaned) markError(error);
				};
				const authorizationRefresh = new AuthorizationRefreshController(
					{
						authorization: initialAuthorization,
						refreshAuthorization,
						applyAuthorization: (replacement) =>
							subscription.renew(replacement),
						onRefreshExhausted: reportError,
					},
				);
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
									`Duplicate Neon Live row ID: ${rowId}`,
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
					batch: LiveQueryBatchInfo,
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
										`Neon Live upserted an existing key: ${String(key)}`,
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
										`Neon Live deleted an unknown row ID: ${change.rowId}`,
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
						// Record the XID after its sync commit has entered TanStack's causal
						// queue. Waiting for an asynchronous receipt here would deadlock a
						// mutation handler that is itself awaiting this XID.
						for (const txid of batch.txids) transactions.seen(txid);
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
				authorizationRefresh.start();

				return () => {
					cleaned = true;
					authorizationRefresh.stop();
					unsubscribeReset();
					unsubscribeBatch();
					unsubscribeState();
					subscription.unsubscribe();
					transactions.close();
					rowIds.clear();
					keys.clear();
				};
			},
		},
	};

	return options;
}
