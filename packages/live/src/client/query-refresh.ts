import type {
	NeonLiveLogMetadata,
	NeonLiveSubscriptionDiagnostics,
} from "./diagnostics.js";
import { type SealedLiveQuery, validateSealedQuery } from "./sealed-query.js";
import type { NeonLiveLogEvent, NeonLiveLogLevel } from "./types.js";

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
	/** Resolve the subscription-scoped diagnostics used by integrations. */
	readonly diagnostics?: () => NeonLiveSubscriptionDiagnostics | undefined;
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

	constructor(private readonly options: QueryRefreshControllerOptions<Row>) {
		this.query = options.query;
		this.refreshQuery = options.refreshQuery;
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
	 * Apply a replacement capability immediately and schedule its next refresh.
	 *
	 * @throws If the replacement capability belongs to a different query, or if
	 * applying it to the active subscription fails.
	 */
	async replaceSealedQuery(query: SealedLiveQuery<Row>): Promise<void> {
		this.assertSameQuery(query);
		try {
			await this.options.renewSubscription(query);
		} catch (error) {
			this.log(
				"warn",
				"subscription_renewal_failed",
				"Neon Live subscription renewal failed",
				{ error },
			);
			throw error;
		}
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
		this.log(
			"debug",
			"query_refresh_scheduled",
			"Neon Live query refresh scheduled",
			{ delayMs: refreshDelay, expiresAt: this.query.expiresAt },
		);
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
		this.log(
			"debug",
			"query_refresh_callback_started",
			"Neon Live query refresh callback started",
		);
		try {
			const query = await refreshQuery();
			if (!this.isCurrent(generation)) return;
			this.log(
				"debug",
				"query_refresh_callback_succeeded",
				"Neon Live query refresh callback succeeded",
			);
			try {
				validateSealedQuery(query);
				this.assertSameQuery(query);
			} catch (error) {
				this.refreshStopped = true;
				this.log(
					"error",
					"query_refresh_stopped",
					"Neon Live query refresh stopped permanently",
					{ error },
				);
				this.options.onRefreshExhausted(error);
				return;
			}

			// Do not let a pending wire renewal prevent the next capability from
			// being obtained. During a long outage, each newer capability supersedes
			// the one still waiting for acceptance.
			this.query = query;
			this.scheduleRefresh();
			void this.renewSubscriptionRecoverably(query, generation);
		} catch (error) {
			if (!this.isCurrent(generation)) return;
			this.log(
				"warn",
				"query_refresh_callback_failed",
				"Neon Live query refresh callback failed; retrying",
				{ error },
			);
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
		} catch (error) {
			if (this.isCurrent(generation) && this.query === query) {
				this.log(
					"warn",
					"subscription_renewal_failed",
					"Neon Live subscription renewal failed; retrying",
					{ error },
				);
				this.scheduleRefresh(REFRESH_RETRY_MS);
			}
		}
	}

	private assertSameQuery(query: SealedLiveQuery<Row>): void {
		if (query.queryFingerprint !== this.query.queryFingerprint) {
			throw new Error("Neon Live renewal must be for the same query");
		}
	}

	private isCurrent(generation: number): boolean {
		return this.active && generation === this.generation;
	}

	private clearTimer(): void {
		if (this.refreshTimer !== undefined) clearTimeout(this.refreshTimer);
		this.refreshTimer = undefined;
	}

	private log(
		level: Exclude<NeonLiveLogLevel, "silent">,
		event: NeonLiveLogEvent,
		message: string,
		metadata: NeonLiveLogMetadata = {},
	): void {
		const context = this.options.diagnostics?.();
		context?.diagnostics.log(level, event, message, {
			...metadata,
			subscriptionId: context.subscriptionId,
		});
	}
}
