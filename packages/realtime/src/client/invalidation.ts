/** Why previously observed live-query state can no longer confirm optimism. */
export type LiveQueryInvalidationReason = "continuity_lost";

/** Signals that retained client-side assumptions must be reconsidered. */
export interface LiveQueryInvalidation {
	/** Stable machine-readable reason for the invalidation. */
	readonly reason: LiveQueryInvalidationReason;
}

/** Rejection used for pending waits when authoritative continuity is lost. */
export class LiveQueryInvalidatedError extends Error {
	readonly name = "LiveQueryInvalidatedError";

	constructor(readonly reason: LiveQueryInvalidationReason) {
		super("Live-query continuity was lost");
	}
}
