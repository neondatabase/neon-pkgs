import type { DiagnosticError } from "../diagnostics.js";
import {
	type ReconnectAttempt,
	ReconnectBackoff,
	type ReconnectOptions,
	type ReconnectTimer,
} from "./reconnect.js";

interface RecoveryEpisode {
	readonly backoff: ReconnectBackoff;
	error: DiagnosticError;
	waiting: boolean;
	delayTimer?: ReconnectTimer;
	stabilityTimer?: ReconnectTimer;
	deadlineTimer?: ReturnType<typeof setTimeout>;
}

export interface SubscriptionRecoveryCallbacks {
	resubscribe(): void;
	exhausted(error: DiagnosticError): void;
	scheduled(code: string, attempt: number, delayMs: number): void;
}

/** Owns a logical subscription's backoff episode independently of its socket. */
export class SubscriptionRecovery {
	private episode?: RecoveryEpisode;
	private stabilityGeneration = 0;

	constructor(
		private readonly options: boolean | ReconnectOptions | undefined,
		private readonly callbacks: SubscriptionRecoveryCallbacks,
	) {}

	get waiting(): boolean {
		return this.episode?.waiting ?? false;
	}

	/** Returns false when recovery is disabled or its policy is exhausted. */
	retry(error: DiagnosticError, retryAfterMs?: number): boolean {
		if (this.options === false) return false;
		this.interrupted();
		let episode: RecoveryEpisode;
		let attempt: ReconnectAttempt | undefined;
		try {
			const options =
				typeof this.options === "object" ? this.options : {};
			episode = this.episode ??= {
				backoff: new ReconnectBackoff(options),
				error,
				waiting: false,
			};
			episode.error = error;
			attempt =
				retryAfterMs !== undefined
					? episode.backoff.nextAfterHint(retryAfterMs)
					: episode.backoff.next();
		} catch {
			this.cancel();
			return false;
		}
		if (!attempt) {
			this.cancel();
			return false;
		}
		if (episode.delayTimer !== undefined)
			episode.backoff.clearTimer(episode.delayTimer);
		episode.waiting = true;
		if (
			episode.deadlineTimer === undefined &&
			Number.isFinite(attempt.remainingMs)
		) {
			// Custom backoff timers cannot disable the absolute elapsed-time bound,
			// including while admission or a complete baseline is still pending.
			episode.deadlineTimer = setTimeout(() => {
				if (this.episode !== episode) return;
				this.cancel();
				this.callbacks.exhausted(episode.error);
			}, attempt.remainingMs);
		}
		episode.delayTimer = episode.backoff.setTimer(() => {
			if (this.episode !== episode || !episode.waiting) return;
			episode.delayTimer = undefined;
			episode.waiting = false;
			// The coordinator waits for socket readiness if this delay expires first.
			this.callbacks.resubscribe();
		}, attempt.delayMs);
		this.callbacks.scheduled(error.code, attempt.attempt, attempt.delayMs);
		return true;
	}

	/** Admission alone does not establish stability; a complete baseline does. */
	baselineCompleted(): void {
		const episode = this.episode;
		if (!episode || episode.waiting) return;
		this.interrupted();
		const generation = this.stabilityGeneration;
		episode.stabilityTimer = episode.backoff.setTimer(() => {
			if (
				this.episode === episode &&
				this.stabilityGeneration === generation
			) {
				this.cancel();
			}
		}, episode.backoff.stabilityMs);
	}

	/** Socket loss, query replacement, and baseline resets preserve the episode. */
	interrupted(): void {
		this.stabilityGeneration += 1;
		const episode = this.episode;
		if (episode?.stabilityTimer !== undefined) {
			episode.backoff.clearTimer(episode.stabilityTimer);
			episode.stabilityTimer = undefined;
		}
	}

	cancel(): void {
		this.interrupted();
		const episode = this.episode;
		if (!episode) return;
		this.episode = undefined;
		if (episode.delayTimer !== undefined)
			episode.backoff.clearTimer(episode.delayTimer);
		if (episode.deadlineTimer !== undefined)
			clearTimeout(episode.deadlineTimer);
	}
}
