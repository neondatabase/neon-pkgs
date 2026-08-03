import type { FetchFunction } from "@ai-sdk/provider-utils";

/**
 * Give every route of this provider the error envelope its model knows how to
 * read, so a failed call surfaces the gateway's reason on `error.message`
 * instead of a bare HTTP status line.
 *
 * The gateway emits several error shapes, and which one you get depends on
 * which layer rejected the request rather than on which route you called:
 *
 * 1. The gateway's own rejection, in OpenAI shape:
 *      { "error": { "message": "unknown model \"nope\"" } }
 *
 * 2. A Databricks rejection, flat and with its own code:
 *      { "error_code": "BAD_REQUEST", "message": "service_tier='flex' is …" }
 *
 * 3. A Databricks rejection wrapping an upstream error as a JSON *string*:
 *      { "error_code": "BAD_REQUEST", "message": "{\"error\":{\"message\":…}}" }
 *
 * Meanwhile each underlying model parses a different schema: the OpenAI and
 * OpenAI-compatible models want `{ error: { message } }`, the Anthropic model
 * wants `{ type: "error", error: { type, message } }`. Anything that does not
 * match is dropped and the AI SDK falls back to the status text, which is how
 * `AI_APICallError: Bad Request` reaches a caller with the real explanation
 * stranded on `responseBody`.
 *
 * So the shape a body needs is a property of the route, not of the gateway:
 * this reads any of the above into one reason and re-emits it in the dialect
 * that route's model expects. Cross-dialect conversion is covered too, since
 * nothing guarantees a given layer answers in the dialect of the route it was
 * reached through. A body already valid for the target dialect is left alone,
 * as is any successful response and anything unrecognised.
 *
 * The Anthropic direction is unverified against a live gateway: that endpoint
 * currently answers every request with a plain-text 404, so no JSON envelope
 * can be observed on it at all.
 *
 * None of the models expose an error hook (`OpenAIConfig` has none, and the
 * Anthropic one takes a fixed handler), so this rides on `fetch` — the same
 * lever `wrapFetchWithHarmonyNormalization` uses. The two are disjoint: that
 * one returns early on a failed response, this one only acts on failures.
 */

/** The error envelope a route's model can parse. */
export type GatewayErrorDialect = "openai" | "anthropic";

interface Reason {
	message: string;
	/** Preserved verbatim when the source was already an OpenAI envelope. */
	openaiFields?: Record<string, unknown>;
	/** An Anthropic `error.type`, or a Databricks `error_code`. */
	type?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asOpenAIEnvelope(value: unknown): Record<string, unknown> | null {
	if (
		isRecord(value) &&
		isRecord(value.error) &&
		typeof value.error.message === "string"
	) {
		return value.error;
	}
	return null;
}

function asAnthropicEnvelope(value: unknown): Record<string, unknown> | null {
	if (
		isRecord(value) &&
		value.type === "error" &&
		isRecord(value.error) &&
		typeof value.error.message === "string" &&
		typeof value.error.type === "string"
	) {
		return value.error;
	}
	return null;
}

/** Read any envelope the gateway emits into a single reason. */
function extractReason(body: unknown): Reason | null {
	const anthropic = asAnthropicEnvelope(body);
	if (anthropic) {
		return {
			message: anthropic.message as string,
			type: anthropic.type as string,
		};
	}

	const openai = asOpenAIEnvelope(body);
	if (openai) {
		return {
			message: openai.message as string,
			openaiFields: openai,
			type: typeof openai.type === "string" ? openai.type : undefined,
		};
	}

	if (!isRecord(body) || typeof body.message !== "string") {
		return null;
	}
	const code =
		typeof body.error_code === "string" ? body.error_code : undefined;

	// Shape 3: an upstream envelope encoded into `message`. Prefer it — it
	// names the offending parameter, which the outer wrapper does not.
	if (body.message.trimStart().startsWith("{")) {
		try {
			const inner: unknown = JSON.parse(body.message);
			const nested = extractReason(inner);
			if (nested) {
				return { ...nested, type: nested.type ?? code };
			}
		} catch {
			// Not JSON after all; fall through to shape 2.
		}
	}

	// Shape 2: a flat Databricks rejection.
	return { message: body.message, type: code };
}

/**
 * Overlay the target envelope on the original body rather than replacing it,
 * so whatever else the gateway sent — `error_code`, request ids, the encoded
 * original message — still reaches the caller on `APICallError.responseBody`.
 */
function emit(
	body: unknown,
	reason: Reason,
	dialect: GatewayErrorDialect,
): unknown {
	const original = isRecord(body) ? body : {};
	if (dialect === "anthropic") {
		return {
			...original,
			type: "error",
			error: {
				...reason.openaiFields,
				type: reason.type ?? "api_error",
				message: reason.message,
			},
		};
	}
	return {
		...original,
		error: {
			...reason.openaiFields,
			message: reason.message,
			code: reason.openaiFields?.code ?? reason.type ?? null,
		},
	};
}

/**
 * Map a gateway error body into `dialect`, or return null when it already
 * parses there (or is not a shape we recognise).
 */
export function normalizeGatewayErrorBody(
	body: unknown,
	dialect: GatewayErrorDialect,
): unknown | null {
	const alreadyValid =
		dialect === "anthropic"
			? asAnthropicEnvelope(body) !== null
			: asOpenAIEnvelope(body) !== null;
	if (alreadyValid) {
		return null;
	}

	const reason = extractReason(body);
	return reason === null ? null : emit(body, reason, dialect);
}

/** Wrap a fetch so failed responses reach the model in its own dialect. */
export function wrapFetchWithGatewayErrorNormalization(
	baseFetch: FetchFunction | undefined,
	dialect: GatewayErrorDialect,
): FetchFunction {
	const inner: FetchFunction =
		baseFetch ?? ((...args) => globalThis.fetch(...args));

	return async (input, init) => {
		const response = await inner(input, init);
		if (response.ok) {
			return response;
		}
		const contentType = response.headers.get("content-type") ?? "";
		if (!contentType.includes("application/json")) {
			return response;
		}

		let parsed: unknown;
		try {
			parsed = JSON.parse(await response.clone().text());
		} catch {
			return response;
		}

		const normalized = normalizeGatewayErrorBody(parsed, dialect);
		if (normalized === null) {
			return response;
		}

		// Rewriting the body invalidates both of these.
		const headers = new Headers(response.headers);
		headers.delete("content-length");
		headers.delete("content-encoding");

		return new Response(JSON.stringify(normalized), {
			status: response.status,
			statusText: response.statusText,
			headers,
		});
	};
}
