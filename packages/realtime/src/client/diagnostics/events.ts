import type { LiveQueryState } from "../types.js";

export interface DiagnosticError extends Error {
	readonly code: string;
	readonly retryable: boolean;
}

export interface ConnectionEventSink {
	attemptStarted(): void;
	ready(): void;
	lost(error: unknown, activeSubscriptionCount: number): void;
	reconnectScheduled(attempt: number, delayMs: number): void;
	reconnectExhausted(error: DiagnosticError): void;
	stable(): void;
	heartbeatPingSent(): void;
	heartbeatPongReceived(): void;
	heartbeatTimedOut(): void;
	publicationCommitted(bodyCount: number): void;
	failed(error: DiagnosticError): void;
	episodeEnded(): void;
}

export interface QueryRefreshEventSink {
	scheduled(delayMs: number, expiresAt: number): void;
	callbackStarted(): void;
	callbackSucceeded(): void;
	callbackFailed(error: unknown): void;
	stopped(error: unknown): void;
}

export interface SubscriptionEventSink {
	readonly refresh: QueryRefreshEventSink;
	started(): void;
	admitted(): void;
	renewalStarted(): void;
	renewalFailed(error: unknown): void;
	renewed(): void;
	unsubscribed(): void;
	live(): void;
	failed(error: DiagnosticError): void;
	queryUnavailable(error: DiagnosticError): void;
	listenerFailed(error: unknown): void;
	stateChanged(
		fromStatus: LiveQueryState["status"],
		toStatus: LiveQueryState["status"],
	): void;
	baselineSyncStarted(): void;
	baselineSyncCompleted(batchCount: number): void;
	resetRequired(): void;
}

export interface ClientEventSink {
	readonly connection: ConnectionEventSink;
	createSubscription(): SubscriptionEventSink;
	closed(): void;
}
