import type { QueryRefreshEventSink } from "./diagnostics.js";
import { subscriptionEventsFor } from "./diagnostics.js";
import { type SealedLiveQuery, validateSealedQuery } from "./sealed-query.js";
import type { RawLiveQuerySubscription } from "./types.js";

const REFRESH_EARLY_MS = 10_000;
const REFRESH_RETRY_MS = 1_000;

interface QueryRefreshControllerOptions<Row> {
	/** Capability from which expiry and query identity are initially read. */
	readonly query: SealedLiveQuery<Row>;
	/** Callback that obtains a replacement capability for the same query. */
	readonly refreshQuery?: () => Promise<SealedLiveQuery<Row>>;
	/** Renew the underlying subscription with a replacement query. */
	readonly renewSubscription: (query: SealedLiveQuery<Row>) => Promise<void>;
	/** Called after the underlying subscription has been renewed successfully. */
	readonly onSubscriptionRenewed?: () => void;
	/** Called when invalid replacement data permanently stops automatic refresh. */
	readonly onRefreshExhausted: (error: unknown) => void;
	/**
	 * Subscription whose diagnostic context receives refresh lifecycle events.
	 * Renewal behavior remains defined by `renewSubscription`, which also
	 * supports integrations that construct the controller before subscribing.
	 */
	readonly subscription?: RawLiveQuerySubscription<Row>;
}

/**
 * Schedules capability refreshes for framework integrations.
 *
 * Most applications should supply `refreshQuery` to their React or
 * TanStack DB integration instead of constructing this class. Integration
 * authors can use it to refresh shortly before expiry and keep retrying across
 * capability expiry or an arbitrarily long transport outage.
 *
 * @typeParam Row - Row produced by the sealed query.
 */
export class QueryRefreshController<Row> {
	private query: SealedLiveQuery<Row>;
	private refreshQuery?: () => Promise<SealedLiveQuery<Row>>;
	private refreshTimer?: ReturnType<typeof setTimeout>;
	private refreshInFlight = false;
	private refreshStopped = false;
	private active = false;
	private generation = 0;
	private refreshEvents: QueryRefreshEventSink;

	constructor(private readonly options: QueryRefreshControllerOptions<Row>) {
		this.query = options.query;
		this.refreshQuery = options.refreshQuery;
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

	/** Associate the active subscription managed by this controller. */
	setSubscription(
		subscription: RawLiveQuerySubscription<Row> | undefined,
	): void {
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
		await this.options.renewSubscription(query);
		this.query = query;
		this.refreshStopped = false;
		this.options.onSubscriptionRenewed?.();
		this.scheduleRefresh();
	}

	/** Start scheduling refreshes. Calling this more than once has no effect. */
	start(): void {
		if (this.active) return;
		this.active = true;
		this.refreshStopped = false;
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

	private async refresh(): Promise<void> {
		const refreshQuery = this.refreshQuery;
		if (
			!this.active ||
			!refreshQuery ||
			this.refreshInFlight ||
			this.refreshStopped
		)
			return;
		this.refreshInFlight = true;
		const generation = this.generation;
		this.refreshEvents.callbackStarted();
		try {
			const query = await refreshQuery();
			if (!this.isCurrent(generation)) return;
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
			this.query = query;
			this.scheduleRefresh();
			void this.renewSubscriptionRecoverably(query, generation);
		} catch (error) {
			if (!this.isCurrent(generation)) return;
			this.refreshEvents.callbackFailed(error);
			this.scheduleRefresh(REFRESH_RETRY_MS);
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
			if (this.isCurrent(generation) && this.query === query)
				this.options.onSubscriptionRenewed?.();
		} catch {
			if (this.isCurrent(generation) && this.query === query) {
				this.scheduleRefresh(REFRESH_RETRY_MS);
			}
		}
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
