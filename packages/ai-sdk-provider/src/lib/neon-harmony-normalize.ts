import type { FetchFunction } from "@ai-sdk/provider-utils";

// Keep this module until the Neon AI Gateway returns a string `content` for
// every model on the unified Chat Completions route. gpt-oss, which it was
// written for (#308), is compliant now, but gemini-3-7-flash, gemini-3-8-flash,
// gemini-4-argon, gemini-3-1-flash-image and gemini-3-pro-image still return
// arrays there, and the AI SDK rejects them without this rewrite.

/**
 * Normalize array `content` from the Neon AI Gateway's unified Chat
 * Completions route into the OpenAI Chat Completions contract before it
 * reaches the AI SDK's schema validation.
 *
 * For some models the gateway returns `message.content` (and streaming
 * `delta.content`) as an array of Responses-style parts. gpt-oss ("harmony")
 * sent reasoning and text:
 *
 *   "content": [
 *     { "type": "reasoning", "summary": [{ "type": "summary_text", "text": "…" }] },
 *     { "type": "text", "text": "…" }
 *   ]
 *
 * and Gemini models send text parts on non-streaming responses:
 *
 *   "content": [{ "type": "text", "text": "…", "thoughtSignature": "…" }]
 *
 * The Chat Completions spec requires `content` to be a string, so any strict
 * OpenAI-compatible client (incl. the Vercel AI SDK) rejects it. We flatten the
 * `text` parts into the string `content` and hoist reasoning into
 * `reasoning_content` (which `@ai-sdk/openai-compatible` already surfaces as an
 * AI SDK reasoning part).
 *
 * The transform only rewrites when `content` is an array, and the fetch wrapper
 * returns the response untouched when nothing was rewritten. So it is a true
 * no-op / pass-through for every spec-compliant model and will not
 * double-transform once the gateway returns a compliant shape.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface ExtractedHarmony {
	text: string;
	reasoning: string;
}

/** The result of a normalization pass, flagging whether anything was rewritten. */
interface NormalizeResult {
	body: unknown;
	changed: boolean;
}

/**
 * Pull the text and reasoning out of a harmony `content` array. Returns `null`
 * when `content` is not an array (i.e. an already-compliant string response),
 * signalling that no rewrite is needed.
 */
export function extractHarmonyContent(
	content: unknown,
): ExtractedHarmony | null {
	if (!Array.isArray(content)) {
		return null;
	}

	const texts: string[] = [];
	const reasonings: string[] = [];

	for (const part of content) {
		if (!isRecord(part)) {
			continue;
		}
		if (part.type === "text") {
			if (typeof part.text === "string") {
				texts.push(part.text);
			}
			continue;
		}
		if (part.type === "reasoning") {
			// Reasoning items can carry the raw CoT in `text`, a `summary[]` of
			// `summary_text` parts, and/or a `content[]` of `reasoning_text` parts.
			if (typeof part.text === "string") {
				reasonings.push(part.text);
			}
			if (Array.isArray(part.summary)) {
				for (const entry of part.summary) {
					if (isRecord(entry) && typeof entry.text === "string") {
						reasonings.push(entry.text);
					}
				}
			}
			if (Array.isArray(part.content)) {
				for (const entry of part.content) {
					if (isRecord(entry) && typeof entry.text === "string") {
						reasonings.push(entry.text);
					}
				}
			}
		}
	}

	return { text: texts.join(""), reasoning: reasonings.join("\n") };
}

/**
 * Rewrite a non-streaming `chat.completion` body in place. `changed` is false
 * when the body was already compliant (no harmony array found).
 */
export function normalizeCompletionBody(body: unknown): NormalizeResult {
	if (!isRecord(body) || !Array.isArray(body.choices)) {
		return { body, changed: false };
	}
	let changed = false;
	for (const choice of body.choices) {
		if (!isRecord(choice)) {
			continue;
		}
		const message = choice.message;
		if (!isRecord(message)) {
			continue;
		}
		const extracted = extractHarmonyContent(message.content);
		if (extracted === null) {
			continue;
		}
		message.content = extracted.text;
		changed = true;
		if (
			extracted.reasoning.length > 0 &&
			message.reasoning_content == null &&
			message.reasoning == null
		) {
			message.reasoning_content = extracted.reasoning;
		}
	}
	return { body, changed };
}

/**
 * Rewrite a streaming `chat.completion.chunk` body in place. `changed` is false
 * when the chunk was already compliant (no harmony array found).
 */
export function normalizeChunkBody(body: unknown): NormalizeResult {
	if (!isRecord(body) || !Array.isArray(body.choices)) {
		return { body, changed: false };
	}
	let changed = false;
	for (const choice of body.choices) {
		if (!isRecord(choice)) {
			continue;
		}
		const delta = choice.delta;
		if (!isRecord(delta)) {
			continue;
		}
		const extracted = extractHarmonyContent(delta.content);
		if (extracted === null) {
			continue;
		}
		changed = true;
		// Drop empty text so reasoning-only chunks don't emit spurious text deltas.
		if (extracted.text.length > 0) {
			delta.content = extracted.text;
		} else {
			delta.content = undefined;
		}
		if (
			extracted.reasoning.length > 0 &&
			delta.reasoning_content == null &&
			delta.reasoning == null
		) {
			delta.reasoning_content = extracted.reasoning;
		}
	}
	return { body, changed };
}

/**
 * Rewrite each `data:` frame of an SSE stream. Compliant frames pass through
 * verbatim; only harmony frames are re-serialized.
 */
function normalizeEventStream(
	body: ReadableStream<Uint8Array>,
): ReadableStream<Uint8Array> {
	const decoder = new TextDecoder();
	const encoder = new TextEncoder();
	let buffer = "";

	const rewriteLine = (line: string): string => {
		if (!line.startsWith("data:")) {
			return line;
		}
		const payload = line.slice("data:".length).trim();
		if (payload === "" || payload === "[DONE]") {
			return line;
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(payload);
		} catch {
			return line;
		}
		const { body: normalized, changed } = normalizeChunkBody(parsed);
		// Pass compliant frames through unchanged so we don't reshape a fixed gateway.
		return changed ? `data: ${JSON.stringify(normalized)}` : line;
	};

	return body.pipeThrough(
		new TransformStream<Uint8Array, Uint8Array>({
			transform(chunk, controller) {
				buffer += decoder.decode(chunk, { stream: true });
				const lines = buffer.split("\n");
				buffer = lines.pop() ?? "";
				for (const line of lines) {
					controller.enqueue(
						encoder.encode(`${rewriteLine(line)}\n`),
					);
				}
			},
			flush(controller) {
				if (buffer.length > 0) {
					controller.enqueue(encoder.encode(rewriteLine(buffer)));
				}
			},
		}),
	);
}

function headersWithout(source: Headers, ...names: string[]): Headers {
	const copy = new Headers(source);
	for (const name of names) {
		copy.delete(name);
	}
	return copy;
}

/**
 * Wrap a fetch implementation so responses with array `content` (Gemini text
 * parts, gpt-oss harmony parts) are normalized to the OpenAI Chat Completions
 * shape before the caller parses them. Composes
 * with a user-supplied `fetch` (falls back to the global `fetch`).
 *
 * When the response is already compliant, the original response is returned
 * untouched.
 */
export function wrapFetchWithHarmonyNormalization(
	baseFetch?: FetchFunction,
): FetchFunction {
	const doFetch: FetchFunction =
		baseFetch ?? ((input, init) => globalThis.fetch(input, init));

	return async (input, init) => {
		const response = await doFetch(input, init);
		if (!response.ok || response.body === null) {
			return response;
		}
		const contentType = response.headers.get("content-type") ?? "";

		if (contentType.includes("text/event-stream")) {
			// Streaming is inspected frame-by-frame; compliant frames pass through
			// verbatim (see normalizeEventStream).
			return new Response(normalizeEventStream(response.body), {
				status: response.status,
				statusText: response.statusText,
				// content-length/encoding no longer describe the (possibly) rewritten body.
				headers: headersWithout(
					response.headers,
					"content-length",
					"content-encoding",
				),
			});
		}

		if (contentType.includes("application/json")) {
			// Inspect a clone so the original body stays intact for the pass-through case.
			let text: string;
			try {
				text = await response.clone().text();
			} catch {
				return response;
			}
			let parsed: unknown;
			try {
				parsed = JSON.parse(text);
			} catch {
				return response;
			}
			const { body: normalized, changed } =
				normalizeCompletionBody(parsed);
			if (!changed) {
				// Already compliant: return the original response untouched.
				return response;
			}
			return new Response(JSON.stringify(normalized), {
				status: response.status,
				statusText: response.statusText,
				headers: headersWithout(
					response.headers,
					"content-length",
					"content-encoding",
				),
			});
		}

		return response;
	};
}
