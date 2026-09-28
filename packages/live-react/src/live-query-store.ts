import {
	AuthorizationRefreshController,
	type LiveQueryAuthorization,
	type LiveQueryBatchInfo,
	type LiveQueryChange,
	type LiveQueryError,
	type LiveQuerySnapshot,
	type LiveQueryState,
	type MaterializedLiveQuerySubscription,
	type NeonLiveClient,
	type RawLiveQueryRow,
} from "@neon/live/client";
import type { UseLiveQueryUtils } from "./types.js";

type SnapshotListener<Row> = (snapshot: LiveQuerySnapshot<Row>) => void;
type StateListener = (state: LiveQueryState) => void;
type ResetListener<Row> = (rows: readonly RawLiveQueryRow<Row>[]) => void;
type BatchListener<Row> = (
	changes: readonly LiveQueryChange<Row>[],
	batch: LiveQueryBatchInfo,
) => void;

export class ReactLiveQueryStore<Row> {
	private readonly reactListeners = new Set<() => void>();
	private readonly snapshotListeners = new Set<SnapshotListener<Row>>();
	private readonly stateListeners = new Set<StateListener>();
	private readonly resetListeners = new Set<ResetListener<Row>>();
	private readonly batchListeners = new Set<BatchListener<Row>>();
	private readonly initialSnapshot: LiveQuerySnapshot<Row>;
	private readonly authorizationRefresh: AuthorizationRefreshController<Row>;
	private subscription?: MaterializedLiveQuerySubscription<Row>;
	private detachForwarders?: () => void;
	private refreshError?: LiveQueryError;
	private snapshot: LiveQuerySnapshot<Row>;
	private hookSnapshot: LiveQuerySnapshot<Row>;

	readonly utils: UseLiveQueryUtils<Row>;

	constructor(
		private readonly client: NeonLiveClient,
		authorization: LiveQueryAuthorization<Row>,
		initialData?: readonly Row[],
	) {
		this.initialSnapshot = Object.freeze({
			status: initialData === undefined ? "connecting" : "stale",
			error: undefined,
			data:
				initialData === undefined
					? undefined
					: Object.freeze([...initialData]),
		});
		this.snapshot = this.initialSnapshot;
		this.hookSnapshot = this.initialSnapshot;
		this.authorizationRefresh = new AuthorizationRefreshController({
			authorization,
			applyAuthorization: (replacement) =>
				this.subscription?.renew(replacement) ?? Promise.resolve(),
			onAuthorizationApplied: () => {
				this.refreshError = undefined;
				const subscription = this.subscription;
				if (subscription) this.update(subscription.getSnapshot());
			},
			onRefreshExhausted: (error) => {
				this.refreshError = new AuthorizationRefreshError(error);
				const subscription = this.subscription;
				if (subscription) this.update(subscription.getSnapshot());
			},
		});
		this.utils = Object.freeze({
			getState: this.getState,
			getSnapshot: this.getSnapshot,
			onReset: this.onReset,
			onBatch: this.onBatch,
			onStateChange: this.onStateChange,
			onChange: this.onChange,
			renew: this.renew,
		});
	}

	setRefreshAuthorization(
		refreshAuthorization:
			| (() => Promise<LiveQueryAuthorization<Row>>)
			| undefined,
	): void {
		this.authorizationRefresh.setRefreshAuthorization(refreshAuthorization);
	}

	subscribe = (listener: () => void): (() => void) => {
		this.reactListeners.add(listener);
		if (this.reactListeners.size === 1) this.open();
		let active = true;
		return () => {
			if (!active) return;
			active = false;
			this.reactListeners.delete(listener);
			if (this.reactListeners.size === 0) this.close();
		};
	};

	getHookSnapshot = (): LiveQuerySnapshot<Row> => this.hookSnapshot;

	getServerSnapshot = (): LiveQuerySnapshot<Row> => this.initialSnapshot;

	private getState = (): LiveQueryState => {
		const { status, error } = this.snapshot;
		return status === "error"
			? Object.freeze({ status, error })
			: Object.freeze({ status, error: undefined });
	};

	private getSnapshot = (): LiveQuerySnapshot<Row> => this.snapshot;

	private onReset = (listener: ResetListener<Row>): (() => void) =>
		listen(this.resetListeners, listener);

	private onBatch = (listener: BatchListener<Row>): (() => void) =>
		listen(this.batchListeners, listener);

	private onStateChange = (listener: StateListener): (() => void) =>
		listen(this.stateListeners, listener);

	private onChange = (listener: SnapshotListener<Row>): (() => void) =>
		listen(this.snapshotListeners, listener);

	private renew = (
		authorization: LiveQueryAuthorization<Row>,
	): Promise<void> =>
		this.authorizationRefresh.replaceAuthorization(authorization);

	private open(): void {
		if (this.subscription) return;
		const subscription = this.client.subscribe(
			this.authorizationRefresh.currentAuthorization(),
			{ initialData: this.initialSnapshot.data },
		);
		this.subscription = subscription;
		this.snapshot = subscription.getSnapshot();
		this.hookSnapshot = this.withRefreshError(this.snapshot);
		const unsubscribers = [
			subscription.onChange((snapshot) => this.update(snapshot)),
			subscription.onStateChange((state) =>
				notify(this.stateListeners, state),
			),
			subscription.onReset((rows) => notify(this.resetListeners, rows)),
			subscription.onBatch((changes, batch) =>
				notify(this.batchListeners, changes, batch),
			),
		];
		this.detachForwarders = () => {
			for (const unsubscribe of unsubscribers) unsubscribe();
		};
		this.authorizationRefresh.start();
	}

	private close(): void {
		this.authorizationRefresh.stop();
		this.detachForwarders?.();
		this.detachForwarders = undefined;
		this.subscription?.unsubscribe();
		this.subscription = undefined;
		this.refreshError = undefined;
		this.snapshot = this.initialSnapshot;
		this.hookSnapshot = this.initialSnapshot;
	}

	private update(snapshot: LiveQuerySnapshot<Row>): void {
		this.snapshot = snapshot;
		const nextHookSnapshot = this.withRefreshError(snapshot);
		if (nextHookSnapshot !== this.hookSnapshot) {
			this.hookSnapshot = nextHookSnapshot;
			notify(this.reactListeners);
		}
		notify(this.snapshotListeners, snapshot);
	}

	private withRefreshError(
		snapshot: LiveQuerySnapshot<Row>,
	): LiveQuerySnapshot<Row> {
		return this.refreshError
			? Object.freeze({
					status: "error",
					error: this.refreshError,
					data: snapshot.data,
				})
			: snapshot;
	}
}

class AuthorizationRefreshError extends Error implements LiveQueryError {
	readonly code = "AUTH_REFRESH_FAILED";
	readonly retryable = false;
	readonly traceId = "client";

	constructor(readonly cause: unknown) {
		super("Neon Live authorization refresh failed");
		this.name = "LiveQueryError";
	}
}

function listen<Listener>(
	listeners: Set<Listener>,
	listener: Listener,
): () => void {
	listeners.add(listener);
	let active = true;
	return () => {
		if (!active) return;
		active = false;
		listeners.delete(listener);
	};
}

function notify<Arguments extends readonly unknown[]>(
	listeners: Set<(...args: Arguments) => void>,
	...args: Arguments
): void {
	for (const listener of [...listeners]) {
		try {
			listener(...args);
		} catch {
			// One application listener cannot interrupt React or stream delivery.
		}
	}
}
