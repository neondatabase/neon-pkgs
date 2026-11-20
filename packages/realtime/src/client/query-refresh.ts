import type { QueryRefreshEventSink } from "./diagnostics.js";
import { subscriptionEventsFor } from "./diagnostics.js";
import type { NoInferCompat } from "./no-infer.js";
import { type SealedLiveQuery, validateSealedQuery } from "./sealed-query.js";
import type { LiveQueryState, RawLiveQuerySubscription } from "./types.js";

const REFRESH_EARLY_MS = 10_000;
const REFRESH_RETRY_MS = 1_000;
const MAX_REFRESH_RETRY_MS = 30_000;

interface QueryRefreshControllerOptions<Row> {
	/** Capability from which expiry and query identity are initially read. */
	readonly query: SealedLiveQuery<Row>;
	/** Callback that obtains a replacement capability for the same query. */
	readonly refreshQuery?: () => Promise<SealedLiveQuery<NoInferCompat<Row>>>;
	/** Renew the underlying subscription with a replacement query. */
	readonly renewSubscription: (
		query: SealedLiveQuery<NoInferCompat<Row>>,
	) => Promise<void>;
	/** Called after the underlying subscription has been renewed successfully. */
	readonly onSubscriptionRenewed?: () => void;
	/** Called when invalid replacement data permanently stops automatic refresh. */
	readonly onRefreshExhausted: (error: unknown) => void;
	/**
	 * Subscription whose diagnostic context receives refresh lifecycle events.
	 * Renewal behavior remains defined by `renewSubscription`, which also
	 * supports integrations that construct the controller before subscribing.
	 * Refreshes stop once this subscription is in error or closed.
	 */
	readonly subscription?: RawLiveQuerySubscription<NoInferCompat<Row>>;
}

interface StatefulSubscription {
	getState(): LiveQueryState;
}

/**
 * Schedules capability refreshes for framework integrations.
 *
 * Most applications should supply `refreshQuery` to their React or
 * TanStack DB integration instead of constructing this class. Integration
 * authors can use it to refresh shortly before expiry and keep retrying across
 * capability expiry or an arbitrarily long transport outage. Refreshes stop
 * once the associated subscription is in error or closed, because neither
 * state can accept a replacement capability.
 *
 * @typeParam Row - Row produced by the sealed query.
 */
export class QueryRefreshController<Row> {
	private query: SealedLiveQuery<Row>;
	private refreshQuery?: () => Promise<SealedLiveQuery<Row>>;
	private refreshTimer?: ReturnType<typeof setTimeout>;
	private refreshInFlight = false;
	private refreshStopped = false;
	private retryDelay = REFRESH_RETRY_MS;
	private active = false;
	private generation = 0;
	private nextReplacementId = 0;
	private appliedReplacementId = 0;
	private refreshEvents: QueryRefreshEventSink;
	private subscription?: StatefulSubscription;

	constructor(private readonly options: QueryRefreshControllerOptions<Row>) {
		this.query = options.query;
		this.refreshQuery = options.refreshQuery;
		this.subscription = options.subscription;
		this.refreshEvents = subscriptionEventsFor(
			options.subscription,
		).refresh;
	}

	/** Return the capability currently managed by this controller. */
	currentQuery(): SealedLiveQuery<Row> {
		return this.query;
	}

	/**
	 * Replace the callback used to obtain a fresh capability.
	 *
	 * Passing `undefined` disables scheduled refreshes without stopping the
	 * controller.
	 */
	setRefreshCallback(
		refreshQuery: (() => Promise<SealedLiveQuery<Row>>) | undefined,
	): void {
		this.refreshQuery = refreshQuery;
		this.clearTimer();
		if (this.active && !this.refreshInFlight && !this.refreshStopped) {
			this.scheduleRefresh();
		}
	}

	/**
	 * Associate the active subscription managed by this controller. Refreshes
	 * stop once it is in error or closed.
	 */
	setSubscription(
		subscription: RawLiveQuerySubscription<Row> | undefined,
	): void {
		this.subscription = subscription;
		this.refreshEvents = subscriptionEventsFor(subscription).refresh;
	}

	/**
	 * Apply a replacement capability immediately and schedule its next refresh.
	 *
	 * @throws If the replacement capability belongs to a different query, or if
	 * applying it to the active subscription fails.
	 */
	async replaceSealedQuery(query: SealedLiveQuery<Row>): Promise<void> {
		this.assertSameQuery(query);
		const generation = this.generation;
		const replacementId = ++this.nextReplacementId;
		await this.options.renewSubscription(query);
		if (
			generation !== this.generation ||
			replacementId < this.appliedReplacementId
		)
			return;
		this.appliedReplacementId = replacementId;
		this.query = query;
		this.retryDelay = REFRESH_RETRY_MS;
		this.refreshStopped = false;
		this.options.onSubscriptionRenewed?.();
		this.scheduleRefresh();
	}

	/** Start scheduling refreshes. Calling this more than once has no effect. */
	start(): void {
		if (this.active) return;
		this.active = true;
		this.refreshStopped = false;
		this.retryDelay = REFRESH_RETRY_MS;
		this.scheduleRefresh();
	}

	/** Stop scheduling refreshes and ignore any refresh already in flight. */
	stop(): void {
		this.active = false;
		this.generation += 1;
		this.clearTimer();
		this.refreshInFlight = false;
		this.refreshStopped = false;
	}

	private scheduleRefresh(delay?: number): void {
		this.clearTimer();
		if (!this.active || !this.refreshQuery || this.refreshStopped) return;
		const refreshDelay =
			delay ??
			Math.max(0, this.query.expiresAt - Date.now() - REFRESH_EARLY_MS);
		this.refreshEvents.scheduled(refreshDelay, this.query.expiresAt);
		this.refreshTimer = setTimeout(() => {
			this.refreshTimer = undefined;
			void this.refresh();
		}, refreshDelay);
	}

	private scheduleRetry(): void {
		const delay = this.retryDelay * (0.5 + Math.random() * 0.5);
		this.retryDelay = Math.min(this.retryDelay * 2, MAX_REFRESH_RETRY_MS);
		this.scheduleRefresh(delay);
	}

	private async refresh(): Promise<void> {
		const refreshQuery = this.refreshQuery;
		if (
			!this.active ||
			!refreshQuery ||
			this.refreshInFlight ||
			this.refreshStopped
		)
			return;
		if (this.subscriptionEnded()) {
			this.refreshStopped = true;
			return;
		}
		this.refreshInFlight = true;
		const generation = this.generation;
		this.refreshEvents.callbackStarted();
		try {
			const query = await refreshQuery();
			if (!this.isCurrent(generation)) return;
			if (this.subscriptionEnded()) {
				this.refreshStopped = true;
				return;
			}
			try {
				validateSealedQuery(query);
				this.assertSameQuery(query);
			} catch (error) {
				this.refreshStopped = true;
				this.refreshEvents.stopped(error);
				this.options.onRefreshExhausted(error);
				return;
			}
			this.refreshEvents.callbackSucceeded();

			// Do not let a pending wire renewal prevent the next capability from
			// being obtained. During a long outage, each newer capability supersedes
			// the one still waiting for acceptance.
			this.appliedReplacementId = ++this.nextReplacementId;
			this.query = query;
			// A short remaining lifetime or clock skew can keep every replacement
			// inside the early-refresh window. Pace successful refreshes too.
			this.scheduleRefresh(
				Math.max(
					REFRESH_RETRY_MS,
					query.expiresAt - Date.now() - REFRESH_EARLY_MS,
				),
			);
			void this.renewSubscriptionRecoverably(query, generation);
		} catch (error) {
			if (!this.isCurrent(generation)) return;
			this.refreshEvents.callbackFailed(error);
			if (this.subscriptionEnded()) {
				this.refreshStopped = true;
				return;
			}
			this.scheduleRetry();
		} finally {
			if (generation === this.generation) this.refreshInFlight = false;
		}
	}

	private async renewSubscriptionRecoverably(
		query: SealedLiveQuery<Row>,
		generation: number,
	): Promise<void> {
		try {
			await this.options.renewSubscription(query);
			if (this.isCurrent(generation) && this.query === query) {
				this.retryDelay = REFRESH_RETRY_MS;
				this.options.onSubscriptionRenewed?.();
			}
		} catch {
			if (!this.isCurrent(generation) || this.query !== query) return;
			if (this.subscriptionEnded()) {
				// A failed or closed subscription rejects every renewal, so
				// retrying would only keep requesting capabilities.
				this.refreshStopped = true;
				this.clearTimer();
				return;
			}
			this.scheduleRetry();
		}
	}

	private subscriptionEnded(): boolean {
		const status = this.subscription?.getState().status;
		return status === "error" || status === "closed";
	}

	private assertSameQuery(query: SealedLiveQuery<Row>): void {
		if (query.queryFingerprint !== this.query.queryFingerprint) {
			throw new Error("Live-query renewal must be for the same query");
		}
	}

	private isCurrent(generation: number): boolean {
		return this.active && generation === this.generation;
	}

	private clearTimer(): void {
		if (this.refreshTimer !== undefined) clearTimeout(this.refreshTimer);
		this.refreshTimer = undefined;
	}
}
