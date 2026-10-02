import {
	decodeServerFrame,
	encodeClientMessage,
	LIVE_SUBPROTOCOL,
	ProtocolError,
} from "../protocol/index.js";
import type { ServerMessage, WireColumn } from "../protocol/messages.js";
import {
	BaselineSyncPublicationReconciler,
	type ReconciliationTarget,
} from "../reconciliation/reconciler.js";
import { ConnectionHeartbeat, type HeartbeatOptions } from "./heartbeat.js";
import {
	type ReconnectAttempt,
	ReconnectBackoff,
	type ReconnectOptions,
} from "./reconnect.js";

const SOCKET_CONNECTING = 0;
const SOCKET_OPEN = 1;
const SOCKET_CLOSING = 2;
const NORMAL_CLOSE = 1_000;
const APPLICATION_CLOSE = 4_000;

export interface ConnectionSealedQuery {
	readonly capability: string;
}

export interface ConnectionCallbacks {
	readonly reconciliation: ReconciliationTarget;
	admitted(columns: readonly WireColumn[]): void;
	disconnected(): void;
	failed(error: ConnectionCoordinatorError): void;
}

export interface ConnectionCoordinatorOptions {
	readonly url: string;
	readonly webSocketFactory?: WebSocketFactory;
	readonly reconnect?: boolean | ReconnectOptions;
	readonly heartbeat?: boolean | HeartbeatOptions;
}

export interface ConnectionHandle {
	renew(query: ConnectionSealedQuery): Promise<void>;
	fail(error: ConnectionCoordinatorError): void;
	unsubscribe(): void;
}

export interface WebSocketLike {
	readonly readyState: number;
	addEventListener(type: "open", listener: () => void): void;
	addEventListener(
		type: "message",
		listener: (event: { readonly data: unknown }) => void,
	): void;
	addEventListener(type: "close", listener: () => void): void;
	addEventListener(type: "error", listener: () => void): void;
	send(data: string): void;
	close(code?: number, reason?: string): void;
}

export type WebSocketFactory = (
	url: string,
	protocols: string | string[],
) => WebSocketLike;

export class ConnectionCoordinatorError extends Error {
	constructor(
		readonly code: string,
		readonly retryable: boolean,
		message: string,
		options?: ErrorOptions,
	) {
		super(message, options);
		this.name = "ConnectionCoordinatorError";
	}
}

interface Renewal {
	readonly query: ConnectionSealedQuery;
	readonly resolve: () => void;
	readonly reject: (error: Error) => void;
}

type ManagedSubscriptionState =
	| "active"
	| "awaiting_query"
	| "failed"
	| "closed";

interface ManagedSubscription {
	query: ConnectionSealedQuery;
	readonly callbacks: ConnectionCallbacks;
	state: ManagedSubscriptionState;
	requestId?: string;
	requestedCapability?: string;
	acceptedCapability?: string;
	liveId?: string;
	renewing?: Renewal;
	queuedRenewals: Renewal[];
}

/** Owns one multiplexed WebSocket and request/live-ID admission routing. */
export class ConnectionCoordinator {
	// All logical subscriptions until they are unsubscribed or the client closes,
	// including subscriptions awaiting a replacement query or in a failed state.
	private readonly managedSubscriptions = new Set<ManagedSubscription>();
	// The managed subset participating in the wire lifecycle. Subscriptions
	// awaiting replacement query, failed, or closed are excluded.
	private readonly activeSubscriptions = new Set<ManagedSubscription>();
	private readonly pendingRequests = new Map<string, ManagedSubscription>();
	private readonly liveSubscriptions = new Map<string, ManagedSubscription>();
	private readonly detachingLiveIds = new Set<string>();
	private readonly reconciler = new BaselineSyncPublicationReconciler();
	private readonly webSocketFactory: WebSocketFactory;
	private readonly reconnect?: ReconnectBackoff;
	private readonly heartbeat?: ConnectionHeartbeat;
	private socket?: WebSocketLike;
	private reconnectTimer?: unknown;
	private reconnectDeadlineTimer?: ReturnType<typeof setTimeout>;
	private stabilityTimer?: unknown;
	private reconnectGeneration = 0;
	private reconnectEpisodeGeneration = 0;
	private requestId = 0n;
	private ready = false;
	private disposed = false;
	private terminalConnection = false;

	constructor(private readonly options: ConnectionCoordinatorOptions) {
		if (!options.url) throw new Error("Neon Live requires a WebSocket URL");
		this.webSocketFactory =
			options.webSocketFactory ?? defaultWebSocketFactory;
		if (options.reconnect !== false) {
			const reconnectOptions =
				options.reconnect === true || options.reconnect === undefined
					? {}
					: options.reconnect;
			this.reconnect = new ReconnectBackoff(reconnectOptions);
		}
		if (options.heartbeat !== false) {
			const heartbeatOptions =
				options.heartbeat === true || options.heartbeat === undefined
					? {}
					: options.heartbeat;
			this.heartbeat = new ConnectionHeartbeat(heartbeatOptions, {
				sendPing: (token) => this.send({ type: "ping", token }),
				timedOut: () =>
					this.closeSocket(APPLICATION_CLOSE, "heartbeat timeout"),
			});
		}
	}

	subscribe(
		query: ConnectionSealedQuery,
		callbacks: ConnectionCallbacks,
	): ConnectionHandle {
		if (this.disposed) throw new Error("Neon Live client is closed");
		validateSealedQuery(query);
		const managed: ManagedSubscription = {
			query,
			callbacks,
			state: "active",
			queuedRenewals: [],
		};
		this.managedSubscriptions.add(managed);
		this.activeSubscriptions.add(managed);
		this.connect();
		if (this.ready) this.sendSubscribe(managed);
		return Object.freeze({
			renew: (replacement: ConnectionSealedQuery) =>
				this.renew(managed, replacement),
			fail: (error: ConnectionCoordinatorError) =>
				this.failLocalSubscription(managed, error),
			unsubscribe: () => this.unsubscribe(managed),
		});
	}

	close(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.cancelReconnectEpisode();
		const error = new Error("Neon Live client is closed");
		for (const subscription of this.managedSubscriptions) {
			this.rejectRenewals(subscription, error);
		}
		this.managedSubscriptions.clear();
		this.activeSubscriptions.clear();
		this.pendingRequests.clear();
		this.liveSubscriptions.clear();
		this.detachingLiveIds.clear();
		this.reconciler.clear();
		this.closeSocket(NORMAL_CLOSE, "client closed");
	}

	private renew(
		subscription: ManagedSubscription,
		query: ConnectionSealedQuery,
	): Promise<void> {
		validateSealedQuery(query);
		if (subscription.state === "closed") {
			return Promise.reject(
				new Error("Neon Live subscription is closed"),
			);
		}
		if (subscription.state === "failed" || this.terminalConnection) {
			return Promise.reject(
				new Error("Neon Live connection cannot recover"),
			);
		}
		subscription.query = query;
		this.rejectQueuedRenewals(
			subscription,
			new Error(
				"Neon Live renewal was superseded by a newer sealed query",
			),
		);
		const renewal = promiseWithResolvers<void>();
		const pending: Renewal = {
			query,
			resolve: () => renewal.resolve(),
			reject: renewal.reject,
		};
		subscription.queuedRenewals.push(pending);
		if (subscription.state === "awaiting_query") {
			subscription.state = "active";
			this.activeSubscriptions.add(subscription);
			this.connect();
			if (this.ready) this.sendSubscribe(subscription);
			return renewal.promise;
		}
		this.sendNextRenewal(subscription);
		return renewal.promise;
	}

	private unsubscribe(subscription: ManagedSubscription): void {
		if (subscription.state === "closed") return;
		subscription.state = "closed";
		this.managedSubscriptions.delete(subscription);
		this.activeSubscriptions.delete(subscription);
		this.rejectRenewals(
			subscription,
			new Error("Neon Live subscription is closed"),
		);
		if (subscription.liveId) {
			this.reconciler.deactivate(subscription.liveId);
			this.liveSubscriptions.delete(subscription.liveId);
			this.detachingLiveIds.add(subscription.liveId);
			this.send({ type: "unsubscribe", live_id: subscription.liveId });
		}
		if (this.activeSubscriptions.size === 0) {
			this.cancelReconnectEpisode();
			this.closeSocket(NORMAL_CLOSE, "no active subscriptions");
		}
	}

	private connect(): void {
		if (
			this.disposed ||
			this.terminalConnection ||
			this.socket?.readyState === SOCKET_CONNECTING ||
			this.socket?.readyState === SOCKET_OPEN
		)
			return;
		this.cancelReconnect();
		this.ready = false;
		let socket: WebSocketLike;
		try {
			socket = this.webSocketFactory(this.options.url, LIVE_SUBPROTOCOL);
		} catch {
			this.scheduleReconnect();
			return;
		}
		this.socket = socket;
		socket.addEventListener("message", (event) => {
			if (this.socket !== socket) return;
			if (typeof event.data !== "string") {
				this.protocolFailure("server sent a non-text frame");
				return;
			}
			this.receive(event.data);
		});
		socket.addEventListener("close", () => {
			if (this.socket !== socket) return;
			this.heartbeat?.stop();
			this.socket = undefined;
			this.disconnected();
		});
		socket.addEventListener("error", () => {
			if (this.socket === socket && socket.readyState < SOCKET_CLOSING) {
				socket.close(APPLICATION_CLOSE, "connection failed");
			}
		});
	}

	private receive(text: string): void {
		try {
			const frame = decodeServerFrame(text);
			this.heartbeat?.received();
			this.route(frame.message, frame.byteLength);
		} catch (error) {
			this.protocolFailure(
				error instanceof Error
					? error.message
					: "invalid server message",
			);
		}
	}

	private route(message: ServerMessage, byteLength: number): void {
		if (!this.ready) {
			if (message.type === "ping") {
				this.send({ type: "pong", token: message.token });
				return;
			}
			if (message.type !== "ready") {
				throw new ProtocolError(
					"expected ready as the first server message",
				);
			}
			this.ready = true;
			this.heartbeat?.start();
			this.armReconnectStability(this.socket);
			for (const subscription of this.activeSubscriptions) {
				this.sendSubscribe(subscription);
			}
			return;
		}

		switch (message.type) {
			case "ready":
				throw new ProtocolError("received duplicate ready");
			case "subscribed":
				this.admitted(message);
				return;
			case "subscribe_rejected":
				this.rejected(message);
				return;
			case "renewed":
				this.renewed(message.live_id);
				return;
			case "unsubscribed":
				this.unsubscribed(message.live_id);
				return;
			case "subscription_error":
				this.subscriptionError(
					message.live_id,
					message.code,
					message.message,
				);
				return;
			case "connection_error":
				this.connectionError(message.code, message.message);
				return;
			case "ping":
				this.send({ type: "pong", token: message.token });
				return;
			case "pong":
				return;
			case "baseline_sync_start":
			case "baseline_sync_batch":
			case "baseline_sync_end":
			case "open":
			case "keyed_results":
			case "reset_required":
			case "commit":
				this.reconciler.accept(message, byteLength);
				return;
		}
	}

	private admitted(
		message: Extract<ServerMessage, { type: "subscribed" }>,
	): void {
		const subscription = this.pendingRequests.get(message.request_id);
		if (
			!subscription ||
			subscription.liveId ||
			this.liveSubscriptions.has(message.live_id)
		) {
			throw new ProtocolError("invalid subscription admission");
		}
		this.pendingRequests.delete(message.request_id);
		subscription.requestId = undefined;
		if (subscription.state === "closed") {
			this.detachingLiveIds.add(message.live_id);
			this.send({ type: "unsubscribe", live_id: message.live_id });
			return;
		}
		if (subscription.state !== "active") {
			throw new ProtocolError("admitted an inactive subscription");
		}
		const acceptedCapability = subscription.requestedCapability;
		if (!acceptedCapability) {
			throw new ProtocolError(
				"admitted a subscription without a sealed query",
			);
		}
		subscription.liveId = message.live_id;
		subscription.acceptedCapability = acceptedCapability;
		this.liveSubscriptions.set(message.live_id, subscription);
		subscription.callbacks.admitted(message.columns);
		this.reconciler.add({
			liveId: message.live_id,
			epoch: message.epoch,
			firstSequence: message.first_sequence,
			columnCount: message.columns.length,
			target: subscription.callbacks.reconciliation,
		});
		if (acceptedCapability === subscription.query.capability) {
			this.resolveRenewals(subscription);
		} else if (subscription.queuedRenewals.length > 0) {
			this.sendNextRenewal(subscription);
		}
		subscription.requestedCapability = undefined;
	}

	private rejected(
		message: Extract<ServerMessage, { type: "subscribe_rejected" }>,
	): void {
		const subscription = this.pendingRequests.get(message.request_id);
		if (!subscription)
			throw new ProtocolError("unknown subscribe request ID");
		this.pendingRequests.delete(message.request_id);
		subscription.requestId = undefined;
		if (subscription.state === "closed") return;
		const error = new ConnectionCoordinatorError(
			message.code,
			false,
			message.message,
		);
		if (requiresReplacementQuery(message.code)) {
			this.awaitReplacementQuery(
				subscription,
				subscription.requestedCapability,
				error,
			);
			return;
		}
		this.failSubscription(subscription, error);
	}

	private renewed(liveId: string): void {
		const subscription = this.liveSubscriptions.get(liveId);
		if (!subscription?.renewing)
			throw new ProtocolError("unexpected renewal response");
		const renewal = subscription.renewing;
		subscription.renewing = undefined;
		subscription.acceptedCapability = renewal.query.capability;
		renewal.resolve();
		this.sendNextRenewal(subscription);
	}

	private unsubscribed(liveId: string): void {
		if (this.detachingLiveIds.delete(liveId)) {
			this.reconciler.remove(liveId);
			return;
		}
		const subscription = this.liveSubscriptions.get(liveId);
		if (!subscription)
			throw new ProtocolError("unknown unsubscribed live ID");
		this.liveSubscriptions.delete(liveId);
		this.reconciler.remove(liveId);
		subscription.liveId = undefined;
		if (subscription.state !== "closed") {
			throw new ProtocolError("server detached an active subscription");
		}
	}

	private subscriptionError(
		liveId: string,
		code: string,
		message: string,
	): void {
		const subscription = this.liveSubscriptions.get(liveId);
		if (!subscription)
			throw new ProtocolError("unknown subscription error live ID");
		const error = new ConnectionCoordinatorError(code, false, message);
		if (requiresReplacementQuery(code)) {
			this.awaitReplacementQuery(
				subscription,
				subscription.acceptedCapability,
				error,
			);
			return;
		}
		this.failSubscription(subscription, error);
	}

	private connectionError(code: string, message: string): void {
		const retryable = [
			"resource_exhausted",
			"slow_consumer",
			"heartbeat_timeout",
			"backend_session_lost",
			"fence_failed",
			"internal_error",
		].includes(code);
		if (retryable) {
			this.closeSocket(APPLICATION_CLOSE, message);
		} else {
			this.failConnection(
				new ConnectionCoordinatorError(code, false, message),
			);
		}
	}

	private sendSubscribe(subscription: ManagedSubscription): void {
		if (
			subscription.state !== "active" ||
			subscription.requestId ||
			subscription.liveId
		)
			return;
		this.requestId += 1n;
		const requestId = this.requestId.toString();
		subscription.requestId = requestId;
		subscription.requestedCapability = subscription.query.capability;
		this.pendingRequests.set(requestId, subscription);
		this.send({
			type: "subscribe",
			request_id: requestId,
			authorization: subscription.query.capability,
		});
	}

	private sendNextRenewal(subscription: ManagedSubscription): void {
		if (
			subscription.state !== "active" ||
			subscription.renewing ||
			!subscription.liveId ||
			!this.ready
		)
			return;
		const renewal = subscription.queuedRenewals.shift();
		if (!renewal) return;
		subscription.renewing = renewal;
		this.send({
			type: "renew",
			live_id: subscription.liveId,
			authorization: renewal.query.capability,
		});
	}

	private disconnected(): void {
		this.ready = false;
		this.cancelStabilityTimer();
		this.pendingRequests.clear();
		this.liveSubscriptions.clear();
		this.detachingLiveIds.clear();
		this.reconciler.clear();
		for (const subscription of this.activeSubscriptions) {
			subscription.requestId = undefined;
			subscription.requestedCapability = undefined;
			subscription.acceptedCapability = undefined;
			subscription.liveId = undefined;
			if (subscription.renewing) {
				subscription.queuedRenewals.unshift(subscription.renewing);
				subscription.renewing = undefined;
			}
			subscription.callbacks.disconnected();
		}
		if (
			!this.disposed &&
			!this.terminalConnection &&
			this.activeSubscriptions.size > 0
		) {
			this.scheduleReconnect();
		}
	}

	private scheduleReconnect(): void {
		if (!this.reconnect) {
			this.reconnectExhausted();
			return;
		}
		let attempt: ReconnectAttempt | undefined;
		try {
			attempt = this.reconnect.next();
		} catch {
			this.reconnectExhausted();
			return;
		}
		if (!attempt) {
			this.reconnectExhausted();
			return;
		}
		if (
			this.reconnectDeadlineTimer === undefined &&
			Number.isFinite(attempt.remainingMs)
		) {
			const episodeGeneration = ++this.reconnectEpisodeGeneration;
			// Keep the absolute safety bound on the host clock. An injected,
			// accelerated backoff timer must not disable or distort it.
			this.reconnectDeadlineTimer = setTimeout(() => {
				this.reconnectDeadlineTimer = undefined;
				if (
					episodeGeneration === this.reconnectEpisodeGeneration &&
					this.reconnect?.active
				)
					this.reconnectExhausted();
			}, attempt.remainingMs);
		}
		const generation = ++this.reconnectGeneration;
		this.reconnectTimer = this.reconnect.setTimer(() => {
			if (
				generation !== this.reconnectGeneration ||
				this.disposed ||
				this.terminalConnection ||
				this.activeSubscriptions.size === 0
			)
				return;
			this.reconnectTimer = undefined;
			this.connect();
		}, attempt.delayMs);
	}

	private armReconnectStability(socket: WebSocketLike | undefined): void {
		if (!socket || !this.reconnect?.active) return;
		this.cancelStabilityTimer();
		const episodeGeneration = this.reconnectEpisodeGeneration;
		this.stabilityTimer = this.reconnect.setTimer(() => {
			if (
				episodeGeneration !== this.reconnectEpisodeGeneration ||
				this.socket !== socket ||
				!this.ready
			)
				return;
			this.stabilityTimer = undefined;
			this.reconnect?.reset();
			this.cancelReconnectDeadline();
		}, this.reconnect.stabilityMs);
	}

	private reconnectExhausted(): void {
		this.failConnection(
			new ConnectionCoordinatorError(
				"connection_lost",
				false,
				"Neon Live connection could not be restored",
			),
		);
	}

	private failSubscription(
		subscription: ManagedSubscription,
		error: ConnectionCoordinatorError,
	): void {
		subscription.state = "failed";
		this.activeSubscriptions.delete(subscription);
		if (subscription.requestId)
			this.pendingRequests.delete(subscription.requestId);
		if (subscription.liveId) {
			this.liveSubscriptions.delete(subscription.liveId);
			this.reconciler.remove(subscription.liveId);
		}
		subscription.requestId = undefined;
		subscription.requestedCapability = undefined;
		subscription.acceptedCapability = undefined;
		subscription.liveId = undefined;
		this.rejectRenewals(subscription, error);
		subscription.callbacks.failed(error);
	}

	private failLocalSubscription(
		subscription: ManagedSubscription,
		error: ConnectionCoordinatorError,
	): void {
		if (subscription.state === "failed" || subscription.state === "closed")
			return;
		subscription.state = "failed";
		this.activeSubscriptions.delete(subscription);
		const liveId = subscription.liveId;
		if (liveId) {
			this.reconciler.deactivate(liveId);
			this.liveSubscriptions.delete(liveId);
			this.detachingLiveIds.add(liveId);
			this.send({ type: "unsubscribe", live_id: liveId });
		}
		if (subscription.requestId)
			this.pendingRequests.delete(subscription.requestId);
		subscription.requestId = undefined;
		subscription.requestedCapability = undefined;
		subscription.acceptedCapability = undefined;
		subscription.liveId = undefined;
		this.rejectRenewals(subscription, error);
		subscription.callbacks.failed(error);
		if (this.activeSubscriptions.size === 0) {
			this.cancelReconnectEpisode();
			this.closeSocket(NORMAL_CLOSE, "no active subscriptions");
		}
	}

	private awaitReplacementQuery(
		subscription: ManagedSubscription,
		rejectedCapability: string | undefined,
		error: ConnectionCoordinatorError,
	): void {
		this.activeSubscriptions.delete(subscription);
		if (subscription.requestId)
			this.pendingRequests.delete(subscription.requestId);
		if (subscription.liveId) {
			this.liveSubscriptions.delete(subscription.liveId);
			this.reconciler.remove(subscription.liveId);
		}
		subscription.requestId = undefined;
		subscription.requestedCapability = undefined;
		subscription.acceptedCapability = undefined;
		subscription.liveId = undefined;
		if (subscription.renewing) {
			subscription.queuedRenewals.unshift(subscription.renewing);
			subscription.renewing = undefined;
		}
		subscription.callbacks.disconnected();

		if (
			rejectedCapability !== undefined &&
			subscription.query.capability !== rejectedCapability
		) {
			subscription.state = "active";
			this.activeSubscriptions.add(subscription);
			this.connect();
			if (this.ready) this.sendSubscribe(subscription);
			return;
		}

		subscription.state = "awaiting_query";
		this.rejectRenewals(subscription, error);
	}

	private protocolFailure(message: string): void {
		this.failConnection(
			new ConnectionCoordinatorError("protocol_error", false, message),
		);
	}

	private failConnection(error: ConnectionCoordinatorError): void {
		if (this.terminalConnection) return;
		this.terminalConnection = true;
		this.cancelReconnectEpisode();
		const subscriptions = [...this.managedSubscriptions].filter(
			(subscription) =>
				subscription.state === "active" ||
				subscription.state === "awaiting_query",
		);
		for (const subscription of subscriptions)
			this.failSubscription(subscription, error);
		this.closeSocket(APPLICATION_CLOSE, "protocol failure");
	}

	private rejectRenewals(
		subscription: ManagedSubscription,
		error: Error,
	): void {
		subscription.renewing?.reject(error);
		subscription.renewing = undefined;
		this.rejectQueuedRenewals(subscription, error);
	}

	private rejectQueuedRenewals(
		subscription: ManagedSubscription,
		error: Error,
	): void {
		for (const renewal of subscription.queuedRenewals)
			renewal.reject(error);
		subscription.queuedRenewals = [];
	}

	private resolveRenewals(subscription: ManagedSubscription): void {
		subscription.renewing?.resolve();
		subscription.renewing = undefined;
		for (const renewal of subscription.queuedRenewals) renewal.resolve();
		subscription.queuedRenewals = [];
	}

	private send(message: Parameters<typeof encodeClientMessage>[0]): boolean {
		if (!this.socket || this.socket.readyState !== SOCKET_OPEN)
			return false;
		this.socket.send(encodeClientMessage(message));
		return true;
	}

	private closeSocket(code: number, reason: string): void {
		this.heartbeat?.stop();
		const socket = this.socket;
		if (socket && socket.readyState < SOCKET_CLOSING)
			socket.close(code, reason);
	}

	private cancelReconnect(): void {
		this.reconnectGeneration += 1;
		if (this.reconnectTimer !== undefined)
			this.reconnect?.clearTimer(this.reconnectTimer);
		this.reconnectTimer = undefined;
	}

	private cancelStabilityTimer(): void {
		if (this.stabilityTimer !== undefined)
			this.reconnect?.clearTimer(this.stabilityTimer);
		this.stabilityTimer = undefined;
	}

	private cancelReconnectDeadline(): void {
		this.reconnectEpisodeGeneration += 1;
		if (this.reconnectDeadlineTimer !== undefined) {
			clearTimeout(this.reconnectDeadlineTimer);
		}
		this.reconnectDeadlineTimer = undefined;
	}

	private cancelReconnectEpisode(): void {
		this.cancelReconnect();
		this.cancelStabilityTimer();
		this.cancelReconnectDeadline();
		this.reconnect?.reset();
	}
}

function defaultWebSocketFactory(
	url: string,
	protocols: string | string[],
): WebSocketLike {
	return new WebSocket(url, protocols);
}

function validateSealedQuery(query: ConnectionSealedQuery): void {
	if (!query || typeof query.capability !== "string" || !query.capability) {
		throw new Error("Invalid Neon Live sealed query");
	}
}

function requiresReplacementQuery(code: string): boolean {
	return code === "authorization_expired" || code === "key_retired";
}

function promiseWithResolvers<Value>(): {
	readonly promise: Promise<Value>;
	readonly resolve: (value: Value | PromiseLike<Value>) => void;
	readonly reject: (reason?: unknown) => void;
} {
	let resolve!: (value: Value | PromiseLike<Value>) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}
