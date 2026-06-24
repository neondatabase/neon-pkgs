/**
 * Typed error hierarchy surfaced on the `error` channel of every ergonomic call (and
 * thrown when `throwOnError` is set). All are `Error` subclasses with a `kind`
 * discriminant, so the same value works whether you read it from `{ error }` or `catch`
 * it.
 */

export type NeonErrorKind =
	| "api"
	| "not_found"
	| "auth"
	| "rate_limit"
	| "operation"
	| "timeout"
	| "network";

/** Base class for every error the ergonomic layer produces. */
export class NeonError extends Error {
	readonly kind: NeonErrorKind;

	constructor(
		message: string,
		kind: NeonErrorKind,
		options?: { cause?: unknown },
	) {
		super(message, options);
		this.name = new.target.name;
		this.kind = kind;
	}
}

/** A non-2xx HTTP response from the Neon API. */
export class NeonApiError extends NeonError {
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

	constructor(
		message: string,
		init: {
			kind?: NeonErrorKind;
			status: number;
			code?: string;
			requestId?: string;
			response?: Response;
			body?: unknown;
		},
	) {
		super(message, init.kind ?? "api");
		this.status = init.status;
		this.code = init.code;
		this.requestId = init.requestId;
		this.response = init.response;
		this.body = init.body;
	}
}

/** 404 — the resource does not exist. */
export class NeonNotFoundError extends NeonApiError {
	constructor(
		message: string,
		init: ConstructorParameters<typeof NeonApiError>[1],
	) {
		super(message, { ...init, kind: "not_found" });
	}
}

/** 401/403 — the API key is missing, invalid, or lacks permission. */
export class NeonAuthError extends NeonApiError {
	constructor(
		message: string,
		init: ConstructorParameters<typeof NeonApiError>[1],
	) {
		super(message, { ...init, kind: "auth" });
	}
}

/** 429 — rate limited (after retries, if enabled, were exhausted). */
export class NeonRateLimitError extends NeonApiError {
	constructor(
		message: string,
		init: ConstructorParameters<typeof NeonApiError>[1],
	) {
		super(message, { ...init, kind: "rate_limit" });
	}
}

/** An awaited Neon operation ended in a non-success terminal state. */
export class NeonOperationError extends NeonError {
	/** The id of the operation that failed. */
	readonly operationId: string;
	/** The terminal status reported by the API (`failed` / `error` / `cancelled`). */
	readonly status: string;

	constructor(
		message: string,
		init: { operationId: string; status: string },
	) {
		super(message, "operation");
		this.operationId = init.operationId;
		this.status = init.status;
	}
}

/** Waiting for operations to finish exceeded the configured timeout. */
export class NeonTimeoutError extends NeonError {
	constructor(message: string) {
		super(message, "timeout");
	}
}

/** A transport-level failure (DNS, connection, abort) — no HTTP response received. */
export class NeonNetworkError extends NeonError {
	constructor(message: string, options?: { cause?: unknown }) {
		super(message, "network", options);
	}
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
 * Build the right {@link NeonError} subclass from a raw client result. `error` is the
 * decoded error body (Neon `GeneralError`); `response` is present unless the failure was
 * transport-level.
 */
export function toNeonError(
	error: unknown,
	response: Response | undefined,
): NeonError {
	if (!response) {
		return new NeonNetworkError(
			"Network error: no response received from the Neon API.",
			{ cause: error },
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
