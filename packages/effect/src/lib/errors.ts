import {
	isNeonError,
	NeonError,
	type NeonErrorUnion,
	type NeonApiError as SdkApiError,
	type NeonAuthError as SdkAuthError,
	type NeonClientError as SdkClientError,
	type NeonNetworkError as SdkNetworkError,
	type NeonNotFoundError as SdkNotFoundError,
	type NeonOperationError as SdkOperationError,
	type NeonRateLimitError as SdkRateLimitError,
	type NeonRequestTimeoutError as SdkRequestTimeoutError,
	type NeonWaitTimeoutError as SdkWaitTimeoutError,
} from "@neon/sdk";
import { Data } from "effect";

interface HttpFields<Cause> {
	readonly message: string;
	/** HTTP status code. */
	readonly status: number;
	/** Machine-readable Neon error code, when present. */
	readonly code: string | undefined;
	/** Neon request id, when present. Quote it in support requests. */
	readonly requestId: string | undefined;
	/** The raw response. */
	readonly response: Response | undefined;
	/** The parsed error body, as returned by the API. */
	readonly body: unknown;
	/** The `@neon/sdk` error this was mapped from. */
	readonly cause: Cause;
}

/** A non-2xx response that has no more specific class. */
export class NeonApiError extends Data.TaggedError("NeonApiError")<
	HttpFields<SdkApiError>
> {}

/** 404: the resource does not exist. */
export class NeonNotFoundError extends Data.TaggedError("NeonNotFoundError")<
	HttpFields<SdkNotFoundError>
> {}

/** 401/403: the API key is missing, invalid, or lacks permission. */
export class NeonAuthError extends Data.TaggedError("NeonAuthError")<
	HttpFields<SdkAuthError>
> {}

/** 429 after the SDK's retries ran out. */
export class NeonRateLimitError extends Data.TaggedError("NeonRateLimitError")<
	HttpFields<SdkRateLimitError>
> {}

/** An awaited Neon operation ended in `failed`, `error`, or `cancelled`. */
export class NeonOperationError extends Data.TaggedError("NeonOperationError")<{
	readonly message: string;
	readonly operationId: string;
	/** The terminal status reported by the API. */
	readonly status: string;
	readonly cause: SdkOperationError;
}> {}

/** `requestTimeoutMs` ran out. The call may never have reached the API. */
export class NeonRequestTimeoutError extends Data.TaggedError(
	"NeonRequestTimeoutError",
)<{
	readonly message: string;
	readonly timeoutMs: number;
	readonly cause: SdkRequestTimeoutError;
}> {}

/**
 * The readiness budget (`wait.timeoutMs`) ran out. The mutation was accepted; pass
 * `operations` to `neon.operations.waitFor` to keep waiting.
 */
export class NeonWaitTimeoutError extends Data.TaggedError(
	"NeonWaitTimeoutError",
)<{
	readonly message: string;
	readonly timeoutMs: number;
	readonly operations: SdkWaitTimeoutError["operations"];
	readonly cause: SdkWaitTimeoutError;
}> {}

/** No HTTP response was received (DNS, connection reset, …). */
export class NeonNetworkError extends Data.TaggedError("NeonNetworkError")<{
	readonly message: string;
	/** The most specific reason the platform gave, such as `ECONNRESET`. */
	readonly reason: string;
	readonly cause: SdkNetworkError;
}> {}

/**
 * A failure the SDK detected itself: invalid configuration or parameters, or a
 * response missing a field it needs.
 */
export class NeonClientError extends Data.TaggedError("NeonClientError")<{
	readonly message: string;
	readonly cause: SdkClientError | NeonError;
}> {}

/**
 * Every error a Neon Effect can fail with. A cancelled call is an interrupted fiber,
 * so the SDK's `aborted` kind has no counterpart here.
 */
export type NeonEffectError =
	| NeonApiError
	| NeonNotFoundError
	| NeonAuthError
	| NeonRateLimitError
	| NeonOperationError
	| NeonRequestTimeoutError
	| NeonWaitTimeoutError
	| NeonNetworkError
	| NeonClientError;

const httpFields = <Cause extends SdkApiError>(
	error: Cause,
): HttpFields<Cause> => ({
	message: error.message,
	status: error.status,
	code: error.code,
	requestId: error.requestId,
	response: error.response,
	body: error.body,
	cause: error,
});

/**
 * Map an `@neon/sdk` error to its tagged counterpart. Anything else is rethrown so
 * Effect records it as a defect rather than as an expected failure.
 */
export function toNeonEffectError(error: unknown): NeonEffectError {
	if (!isNeonError(error)) {
		// `createNeonClient` rejects bad config with the base class, which
		// `isNeonError` does not recognise.
		if (error instanceof NeonError && error.kind === "client") {
			return new NeonClientError({
				message: error.message,
				cause: error,
			});
		}
		throw error;
	}
	return fromUnion(error);
}

function fromUnion(error: NeonErrorUnion): NeonEffectError {
	switch (error.kind) {
		case "api":
			return new NeonApiError(httpFields(error));
		case "not_found":
			return new NeonNotFoundError(httpFields(error));
		case "auth":
			return new NeonAuthError(httpFields(error));
		case "rate_limit":
			return new NeonRateLimitError(httpFields(error));
		case "operation":
			return new NeonOperationError({
				message: error.message,
				operationId: error.operationId,
				status: error.status,
				cause: error,
			});
		case "timeout":
			return error.source === "wait"
				? new NeonWaitTimeoutError({
						message: error.message,
						timeoutMs: error.timeoutMs,
						operations: error.operations,
						cause: error,
					})
				: new NeonRequestTimeoutError({
						message: error.message,
						timeoutMs: error.timeoutMs,
						cause: error,
					});
		case "network":
			return new NeonNetworkError({
				message: error.message,
				reason: error.reason,
				cause: error,
			});
		case "client":
			return new NeonClientError({
				message: error.message,
				cause: error,
			});
		case "aborted":
			// Only our own signal aborts a call, and only when the fiber was
			// interrupted, so Effect discards whatever this produces.
			throw error;
	}
}
