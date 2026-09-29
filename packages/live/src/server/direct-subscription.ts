import type { LiveQueryAuthorization } from "../client/authorization.js";
import { AuthorizationRefreshController } from "../client/authorization-refresh.js";
import type {
	LiveQueryBatchInfo,
	LiveQueryChange,
	LiveQuerySnapshot,
	LiveQueryState,
	MaterializedLiveQuerySubscription,
	RawLiveQueryRow,
	RawLiveQuerySubscription,
} from "../client/types.js";

export interface ManagedDirectSubscription<Subscription> {
	readonly subscription: Subscription;
	stopRefresh(): void;
}

/** Add automatic capability refresh to an existing low-level subscription. */
export function manageDirectSubscription<
	Row,
	Subscription extends RawLiveQuerySubscription<Row>,
>(
	subscription: Subscription,
	authorization: LiveQueryAuthorization<Row>,
	refreshAuthorization: () => Promise<LiveQueryAuthorization<Row>>,
	removed: () => void,
): ManagedDirectSubscription<Subscription> {
	let stopped = false;
	let detachStateListener: () => void = () => undefined;
	const refresh = new AuthorizationRefreshController({
		authorization,
		refreshAuthorization,
		applyAuthorization: (authorization) =>
			subscription.renew(authorization),
		onRefreshExhausted: () => undefined,
	});

	const stopRefresh = () => {
		if (stopped) return;
		stopped = true;
		refresh.stop();
		detachStateListener();
		removed();
	};
	detachStateListener = subscription.onStateChange((state) => {
		if (state.status === "error") stopRefresh();
	});
	const base = {
		getState: () => subscription.getState(),
		onReset: (listener: (rows: readonly RawLiveQueryRow<Row>[]) => void) =>
			subscription.onReset(listener),
		onBatch: (
			listener: (
				changes: readonly LiveQueryChange<Row>[],
				batch: LiveQueryBatchInfo,
			) => void,
		) => subscription.onBatch(listener),
		onStateChange: (listener: (state: LiveQueryState) => void) =>
			subscription.onStateChange(listener),
		awaitTxId: (txid: string, timeout?: number) =>
			subscription.awaitTxId(txid, timeout),
		renew: (authorization: LiveQueryAuthorization<Row>) =>
			refresh.replaceAuthorization(authorization),
		unsubscribe: () => {
			stopRefresh();
			subscription.unsubscribe();
		},
	};
	const managed = isMaterialized(subscription)
		? {
				...base,
				getSnapshot: () => subscription.getSnapshot(),
				onChange: (
					listener: (snapshot: LiveQuerySnapshot<Row>) => void,
				) => subscription.onChange(listener),
			}
		: base;

	refresh.start();
	return Object.freeze({
		subscription: Object.freeze(managed) as Subscription,
		stopRefresh,
	});
}

function isMaterialized<Row>(
	subscription: RawLiveQuerySubscription<Row>,
): subscription is MaterializedLiveQuerySubscription<Row> {
	return "getSnapshot" in subscription && "onChange" in subscription;
}
