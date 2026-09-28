import {
	type LiveQueryAuthorization,
	validateAuthorization,
} from "./authorization.js";

const REFRESH_EARLY_MS = 10_000;
const REFRESH_RETRY_MS = 1_000;

interface AuthorizationRefreshControllerOptions<Row> {
	/** Capability from which expiry and query identity are initially read. */
	readonly authorization: LiveQueryAuthorization<Row>;
	/** Callback that obtains a replacement capability for the same query. */
	readonly refreshAuthorization?: () => Promise<LiveQueryAuthorization<Row>>;
	/** Install a replacement on the underlying subscription. */
	readonly applyAuthorization: (
		authorization: LiveQueryAuthorization<Row>,
	) => Promise<void>;
	/** Called after a replacement has been installed successfully. */
	readonly onAuthorizationApplied?: () => void;
	/** Called when invalid replacement data permanently stops automatic refresh. */
	readonly onRefreshExhausted: (error: unknown) => void;
}

/**
 * Schedules capability refreshes for framework integrations.
 *
 * Most applications should supply `refreshAuthorization` to their React or
 * TanStack DB integration instead of constructing this class. Integration
 * authors can use it to refresh shortly before expiry and keep retrying across
 * capability expiry or an arbitrarily long transport outage.
 *
 * @typeParam Row - Row produced by the authorized query.
 */
export class AuthorizationRefreshController<Row> {
	private authorization: LiveQueryAuthorization<Row>;
	private refreshAuthorization?: () => Promise<LiveQueryAuthorization<Row>>;
	private refreshTimer?: ReturnType<typeof setTimeout>;
	private refreshInFlight = false;
	private refreshStopped = false;
	private active = false;
	private generation = 0;

	constructor(
		private readonly options: AuthorizationRefreshControllerOptions<Row>,
	) {
		this.authorization = options.authorization;
		this.refreshAuthorization = options.refreshAuthorization;
	}

	/** Return the capability currently managed by this controller. */
	currentAuthorization(): LiveQueryAuthorization<Row> {
		return this.authorization;
	}

	/**
	 * Replace the callback used to obtain a fresh capability.
	 *
	 * Passing `undefined` disables scheduled refreshes without stopping the
	 * controller.
	 */
	setRefreshAuthorization(
		refreshAuthorization:
			| (() => Promise<LiveQueryAuthorization<Row>>)
			| undefined,
	): void {
		this.refreshAuthorization = refreshAuthorization;
		this.clearTimer();
		if (this.active && !this.refreshInFlight && !this.refreshStopped) {
			this.scheduleRefresh();
		}
	}

	/**
	 * Apply a replacement capability immediately and schedule its next refresh.
	 *
	 * @throws If the replacement capability authorizes a different query, or if
	 * applying it to the active subscription fails.
	 */
	async replaceAuthorization(
		authorization: LiveQueryAuthorization<Row>,
	): Promise<void> {
		this.assertSameQuery(authorization);
		await this.options.applyAuthorization(authorization);
		this.authorization = authorization;
		this.refreshStopped = false;
		this.options.onAuthorizationApplied?.();
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
		if (!this.active || !this.refreshAuthorization || this.refreshStopped)
			return;
		const refreshDelay =
			delay ??
			Math.max(
				0,
				this.authorization.expiresAt - Date.now() - REFRESH_EARLY_MS,
			);
		this.refreshTimer = setTimeout(() => {
			this.refreshTimer = undefined;
			void this.refresh();
		}, refreshDelay);
	}

	private async refresh(): Promise<void> {
		const refreshAuthorization = this.refreshAuthorization;
		if (
			!this.active ||
			!refreshAuthorization ||
			this.refreshInFlight ||
			this.refreshStopped
		)
			return;
		this.refreshInFlight = true;
		const generation = this.generation;
		try {
			const authorization = await refreshAuthorization();
			if (!this.isCurrent(generation)) return;
			try {
				validateAuthorization(authorization);
				this.assertSameQuery(authorization);
			} catch (error) {
				this.refreshStopped = true;
				this.options.onRefreshExhausted(error);
				return;
			}

			// Do not let a pending wire renewal prevent the next capability from
			// being obtained. During a long outage, each newer capability supersedes
			// the one still waiting for acceptance.
			this.authorization = authorization;
			this.scheduleRefresh();
			void this.applyRecoverableAuthorization(authorization, generation);
		} catch {
			if (!this.isCurrent(generation)) return;
			this.scheduleRefresh(REFRESH_RETRY_MS);
		} finally {
			if (generation === this.generation) this.refreshInFlight = false;
		}
	}

	private async applyRecoverableAuthorization(
		authorization: LiveQueryAuthorization<Row>,
		generation: number,
	): Promise<void> {
		try {
			await this.options.applyAuthorization(authorization);
			if (
				this.isCurrent(generation) &&
				this.authorization === authorization
			)
				this.options.onAuthorizationApplied?.();
		} catch {
			if (
				this.isCurrent(generation) &&
				this.authorization === authorization
			)
				this.scheduleRefresh(REFRESH_RETRY_MS);
		}
	}

	private assertSameQuery(authorization: LiveQueryAuthorization<Row>): void {
		if (
			authorization.queryFingerprint !==
			this.authorization.queryFingerprint
		) {
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
}
