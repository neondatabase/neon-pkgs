/**
 * Typed error hierarchy surfaced on the `error` channel of every ergonomic call (and
 * thrown when `throwOnError` is set). All are `Error` subclasses. Each concrete class
 * carries a literal `kind`, so {@link NeonErrorUnion} is a discriminated union: a
 * `kind` check narrows to that class. Every member extends {@link NeonError}, so
 * `instanceof NeonError` still matches all of them.
 */

/** Used when a transport failure carries neither an `errno` code nor any message. */
const UNKNOWN_TRANSPORT_REASON = "cause unavailable";

export type NeonErrorKind =
	| "api"
	| "not_found"
	| "auth"
	| "rate_limit"
	| "operation"
	| "timeout"
	| "aborted"
	| "network"
	| "client";

/** The `kind`s an HTTP-response error can carry. */
export type NeonApiErrorKind = "api" | "not_found" | "auth" | "rate_limit";

interface NeonApiErrorInit {
	status: number;
	code?: string;
	requestId?: string;
	response?: Response;
	body?: unknown;
}

/**
 * Base class for every error the ergonomic layer produces.
 *
 * Every subclass assigns `this.name` as a string literal rather than reading it from the
 * constructor. Bundlers rename classes, so deriving the name at runtime leaves consumers
 * of a minified build with errors called `s` and `r` — unreadable in logs and impossible
 * to group on in an error tracker.
 *
 * The SDK does not construct this class directly; it emits {@link NeonErrorUnion} members.
 */
export class NeonError extends Error {
	readonly kind: NeonErrorKind;

	constructor(
		message: string,
		kind: NeonErrorKind,
		options?: { cause?: unknown },
	) {
		super(message, options);
		this.name = "NeonError";
		this.kind = kind;
	}
}

/** A non-2xx HTTP response from the Neon API. */
export class NeonApiError<
	K extends NeonApiErrorKind = "api",
> extends NeonError {
	declare readonly kind: K;
	/** HTTP status code. */
	readonly status: number;
	/** Machine-readable Neon error code (`GeneralError.code`), when present. */
	readonly code?: string;
	/** Neon request id (`X-Request-Id` / `GeneralError.request_id`), when present. */
	readonly requestId?: string;
	/** The raw response, when one was received. */
	readonly response?: Response;
	/** The parsed error body, as returned by the API. */
	readonly body: unknown;

	constructor(message: string, init: NeonApiErrorInit) {
		super(message, "api");
		this.name = "NeonApiError";
		this.status = init.status;
		this.code = init.code;
		this.requestId = init.requestId;
		this.response = init.response;
		this.body = init.body;
	}
}

/** 404 — the resource does not exist. */
export class NeonNotFoundError extends NeonApiError<"not_found"> {
	// Assigned after super() so the runtime kind matches the generic, not "api".
	override readonly kind: "not_found" = "not_found";
	constructor(message: string, init: NeonApiErrorInit) {
		super(message, init);
		this.name = "NeonNotFoundError";
	}
}

/** 401/403 — the API key is missing, invalid, or lacks permission. */
export class NeonAuthError extends NeonApiError<"auth"> {
	override readonly kind: "auth" = "auth";
	constructor(message: string, init: NeonApiErrorInit) {
		super(message, init);
		this.name = "NeonAuthError";
	}
}

/** 429 — rate limited (after retries, if enabled, were exhausted). */
export class NeonRateLimitError extends NeonApiError<"rate_limit"> {
	override readonly kind: "rate_limit" = "rate_limit";
	constructor(message: string, init: NeonApiErrorInit) {
		super(message, init);
		this.name = "NeonRateLimitError";
	}
}

/** An awaited Neon operation ended in a non-success terminal state. */
export class NeonOperationError extends NeonError {
	declare readonly kind: "operation";
	/** The id of the operation that failed. */
	readonly operationId: string;
	/** The terminal status reported by the API (`failed` / `error` / `cancelled`). */
	readonly status: string;

	constructor(
		message: string,
		init: { operationId: string; status: string },
	) {
		super(message, "operation");
		this.name = "NeonOperationError";
		this.operationId = init.operationId;
		this.status = init.status;
	}
}

/**
 * A deadline was exceeded — either `requestTimeoutMs` for a request and its retries, or
 * the `wait` budget while polling operations for readiness.
 */
export class NeonTimeoutError extends NeonError {
	declare readonly kind: "timeout";
	constructor(message: string) {
		super(message, "timeout");
		this.name = "NeonTimeoutError";
	}
}

/**
 * The caller's `AbortSignal` fired. Distinct from {@link NeonTimeoutError} because nothing
 * went wrong: the caller asked for the work to stop, and the two call for different
 * handling (retry a timeout, don't retry a cancellation).
 *
 * Raised only where the SDK knows the caller cancelled — the call's own deadline, or an
 * already-aborted `signal` on a raw call. A transport failure that merely looks like an
 * abort stays a {@link NeonNetworkError}, since the generated client reports auth,
 * serialization, interceptor and parsing faults through the same channel and an error's
 * name is not evidence about which one occurred.
 */
export class NeonAbortError extends NeonError {
	declare readonly kind: "aborted";
	constructor(message: string, options?: { cause?: unknown }) {
		super(message, "aborted", options);
		this.name = "NeonAbortError";
	}
}

/** A transport-level failure (DNS, connection, abort) — no HTTP response received. */
export class NeonNetworkError extends NeonError {
	declare readonly kind: "network";
	/**
	 * The most specific reason the platform gave for the failure — an `errno` code such as
	 * `ECONNRESET` when one is available, otherwise the innermost non-empty message. Read
	 * this instead of matching on {@link message}.
	 */
	readonly reason: string;

	constructor(
		message: string,
		options?: { cause?: unknown; reason?: string },
	) {
		super(message, "network", { cause: options?.cause });
		this.name = "NeonNetworkError";
		this.reason = options?.reason ?? UNKNOWN_TRANSPORT_REASON;
	}
}

/**
 * A failure the SDK detected itself, before or after talking to the API — an ambiguous
 * connection-string selection, an invalid `requestTimeoutMs`, a `noCompute` branch with
 * compute settings, a response missing a field the wrapper needs. Nothing was wrong on
 * the wire; the call could not be completed as asked.
 */
export class NeonClientError extends NeonError {
	declare readonly kind: "client";
	constructor(message: string, options?: { cause?: unknown }) {
		super(message, "client", options);
		this.name = "NeonClientError";
	}
}

/**
 * Every error the SDK emits, as a discriminated union on `kind`. This is the type of
 * `NeonResult`/`RawResult`'s `error` and of what `throwOnError` throws. Every member
 * extends {@link NeonError}, so `instanceof NeonError` still matches all of them.
 */
export type NeonErrorUnion =
	| NeonApiError
	| NeonNotFoundError
	| NeonAuthError
	| NeonRateLimitError
	| NeonOperationError
	| NeonTimeoutError
	| NeonAbortError
	| NeonNetworkError
	| NeonClientError;

/**
 * Whether `error` is one of the classes {@link NeonErrorUnion} names. Used where a value
 * arrives as `unknown` or as the base {@link NeonError} (for example a page fetcher that
 * already classified a failure) and must be handed to `err()`.
 */
export function isNeonErrorUnion(error: unknown): error is NeonErrorUnion {
	return (
		error instanceof NeonApiError ||
		error instanceof NeonOperationError ||
		error instanceof NeonTimeoutError ||
		error instanceof NeonAbortError ||
		error instanceof NeonNetworkError ||
		error instanceof NeonClientError
	);
}

interface ApiErrorBody {
	message?: string;
	code?: string;
	request_id?: string;
}

function readApiErrorBody(body: unknown): ApiErrorBody {
	if (typeof body !== "object" || body === null) return {};
	const out: ApiErrorBody = {};
	if ("message" in body && typeof body.message === "string")
		out.message = body.message;
	if ("code" in body && typeof body.code === "string") out.code = body.code;
	if ("request_id" in body && typeof body.request_id === "string") {
		out.request_id = body.request_id;
	}
	return out;
}

/**
 * Walk a transport failure's `cause` chain for the most specific description available.
 *
 * `fetch` reports every transport fault as `TypeError: fetch failed` and puts the real
 * reason underneath, sometimes several levels down and sometimes with an empty message and
 * only an `errno` code. Without this, a DNS failure, a reset connection and a redirect the
 * client refused to follow all produce the same sentence.
 */
export function describeTransportFailure(error: unknown): string {
	const seen = new Set<unknown>();
	let current: unknown = error;
	let deepestMessage: string | undefined;

	while (current instanceof Error && !seen.has(current)) {
		seen.add(current);
		if ("code" in current && typeof current.code === "string") {
			return current.code;
		}
		if (current.message) deepestMessage = current.message;
		current = current.cause;
	}

	return deepestMessage ?? UNKNOWN_TRANSPORT_REASON;
}

/**
 * Build the right {@link NeonError} subclass from a raw client result. `error` is the
 * decoded error body (Neon `GeneralError`); `response` is present unless the failure was
 * transport-level.
 */
export function toNeonError(
	error: unknown,
	response: Response | undefined,
): NeonErrorUnion {
	if (!response) {
		const reason = describeTransportFailure(error);
		return new NeonNetworkError(
			`Network error: no response received from the Neon API (${reason}).`,
			{ cause: error, reason },
		);
	}

	const parsed = readApiErrorBody(error);
	const status = response.status;
	const message =
		parsed.message ?? `Neon API request failed with status ${status}.`;
	const init = {
		status,
		code: parsed.code,
		requestId:
			parsed.request_id ??
			response.headers.get("x-request-id") ??
			undefined,
		response,
		body: error,
	};

	if (status === 404) return new NeonNotFoundError(message, init);
	if (status === 401 || status === 403)
		return new NeonAuthError(message, init);
	if (status === 429) return new NeonRateLimitError(message, init);
	return new NeonApiError(message, init);
}
