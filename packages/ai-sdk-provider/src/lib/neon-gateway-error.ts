import type { FetchFunction } from "@ai-sdk/provider-utils";

/**
 * Rewrite the Neon AI Gateway's non-OpenAI error envelopes into the shape
 * `@ai-sdk/openai` parses, so the reason reaches `error.message` instead of
 * being flattened to the bare HTTP status text.
 *
 * The Responses route returns three different error shapes:
 *
 * 1. The gateway's own rejection, already OpenAI-shaped and passed through
 *    untouched:
 *      { "error": { "message": "unknown model \"nope\"" } }
 *
 * 2. A Databricks rejection, top-level and unparseable by the OpenAI schema:
 *      { "error_code": "INVALID_PARAMETER_VALUE", "message": "…" }
 *
 * 3. A Databricks rejection wrapping an OpenAI error as a JSON *string*:
 *      { "error_code": "BAD_REQUEST", "message": "{\"error\":{\"message\":…}}" }
 *
 * Shapes 2 and 3 both fail `openaiErrorDataSchema` (which requires a nested
 * `error.message`), so the AI SDK falls back to the status line and the caller
 * sees `AI_APICallError: Bad Request` with the real explanation buried in
 * `responseBody`. Shape 3 is the worst of the three: the useful text — the
 * offending parameter and its allowed range — is two levels down.
 *
 * `OpenAIConfig` exposes no error-handler hook, so the rewrite happens in
 * `fetch`, the same lever `wrapFetchWithHarmonyNormalization` uses. Successful
 * responses and already-compliant errors are returned untouched.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** An OpenAI-shaped envelope the AI SDK can already parse. */
function isOpenAIShaped(value: unknown): boolean {
	return (
		isRecord(value) &&
		isRecord(value.error) &&
		typeof value.error.message === "string"
	);
}

/**
 * Map one gateway error body to the OpenAI envelope, or return null when it
 * needs no rewriting (or isn't a shape we recognise).
 */
export function normalizeGatewayErrorBody(body: unknown): unknown | null {
	if (!isRecord(body) || isOpenAIShaped(body)) {
		return null;
	}
	const { error_code: errorCode, message } = body;
	if (typeof message !== "string") {
		return null;
	}

	// Shape 3: the message is itself an OpenAI error envelope. Prefer it — it
	// names the offending parameter, which the outer wrapper does not.
	if (message.trimStart().startsWith("{")) {
		try {
			const inner: unknown = JSON.parse(message);
			if (isOpenAIShaped(inner)) {
				const { error } = inner as { error: Record<string, unknown> };
				return {
					error: { ...error, code: error.code ?? errorCode ?? null },
				};
			}
		} catch {
			// Not JSON after all; fall through to shape 2.
		}
	}

	// Shape 2: a flat Databricks rejection.
	return { error: { message, code: errorCode ?? null } };
}

/** Wrap a fetch so gateway error bodies reach the AI SDK in OpenAI shape. */
export function wrapFetchWithGatewayErrorNormalization(
	baseFetch?: FetchFunction,
): FetchFunction {
	const inner: FetchFunction =
		baseFetch ?? ((...args) => globalThis.fetch(...args));

	return async (input, init) => {
		const response = await inner(input, init);
		if (response.ok) {
			return response;
		}
		if (
			!(response.headers.get("content-type") ?? "").includes(
				"application/json",
			)
		) {
			return response;
		}

		const raw = await response.clone().text();
		let parsed: unknown;
		try {
			parsed = JSON.parse(raw);
		} catch {
			return response;
		}

		const normalized = normalizeGatewayErrorBody(parsed);
		if (normalized === null) {
			return response;
		}

		return new Response(JSON.stringify(normalized), {
			status: response.status,
			statusText: response.statusText,
			headers: response.headers,
		});
	};
}
