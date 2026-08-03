# @neon/ai-sdk-provider

Community [Vercel AI SDK](https://ai-sdk.dev) provider for the [Neon](https://neon.com) AI Gateway. Supports **AI SDK v6 and v7** (`ai@^6` or `ai@^7`).

The Neon AI Gateway is **branch-scoped**: each Neon project branch gets its own gateway host, and a platform token authorizes requests for that branch. This provider routes each model to the best gateway endpoint (Anthropic → native Messages, OpenAI → native Responses incl. **Codex**, everything else → unified OpenAI-compatible MLflow endpoint), so a single `neon('claude-...')` call reaches the whole catalog.

Model ids use the canonical Neon (unprefixed) form — `claude-sonnet-4-6`, `gpt-5`, `gemini-2-5-flash` — matching the [`neon` provider on models.dev](https://models.dev). The typed catalog mirrors that provider exactly (kept in sync by a scheduled drift check), plus a few extra gateway-served ids that models.dev doesn't list yet (e.g. Codex, Llama, Qwen). Any other id — including the legacy `databricks-` prefixed form (`databricks-claude-sonnet-4-6`) — is still accepted as a plain string, so existing code keeps working.

## Install

```bash
npm install @neon/ai-sdk-provider ai
```

> **Requirements:** Node.js >= 20.19 with AI SDK 6. AI SDK 7 itself requires Node.js >= 22.

## Configuration

The gateway URL is branch-scoped, so both values come from the Neon Console (your project → a branch → **AI Gateway** tab), or from `neon env pull` / `neon dev`:

```bash
NEON_AI_GATEWAY_BASE_URL="https://<branch-id>-api.ai.<region>.aws.neon.tech"
NEON_AI_GATEWAY_TOKEN="nt_live_..."
```

## Usage

```ts
import { neon } from "@neon/ai-sdk-provider";
import { generateText } from "ai";

// Reads NEON_AI_GATEWAY_BASE_URL + NEON_AI_GATEWAY_TOKEN from the environment.
const { text } = await generateText({
  model: neon("claude-haiku-4-5"), // or 'gpt-5-3-codex', etc.
  prompt: "Summarize Postgres for me.",
});
```

Or configure explicitly with `createNeon`:

```ts
import { createNeon } from "@neon/ai-sdk-provider";

const neon = createNeon({
  baseURL: process.env.NEON_AI_GATEWAY_BASE_URL,
  apiKey: process.env.NEON_AI_GATEWAY_TOKEN,
});
```

## Routing

| Model family | Endpoint | Why |
| --- | --- | --- |
| Anthropic (`claude-*`) | native Messages API | streaming structured output + native reasoning |
| OpenAI (`gpt-*`, `*-codex`) | native Responses API | Codex (native-only), native reasoning, image-gen tool |
| Everything else (Gemini, Llama, Qwen, gpt-oss, ...) | unified MLflow endpoint | broad coverage; Gemini is here because its native endpoint does not support streaming |

Routing matches on the model id, so both the canonical (`gpt-5`) and the legacy `databricks-`-prefixed (`databricks-gpt-5`) forms route identically.

## Capabilities

`generateText` / `streamText` (text, system prompts, multi-turn) and image (vision) input work across every family the gateway serves. Tool calling (single and multi-step, generate and stream) and `generateObject` / `streamObject` are verified on OpenAI (incl. Codex), Meta and Alibaba models.

Two exceptions, measured against a live branch:

| Family | Works | Does not |
| --- | --- | --- |
| Google (`gemini-3-*`) | `generateText`, `streamText` | `generateObject` returns prose the SDK cannot parse; a tool round trip 400s on the replay leg, because the AI SDK does not echo back the `thoughtSignature` Gemini expects |
| Anthropic (`claude-*`) | — | No `claude-*` id is served during the beta, so nothing on this route can be exercised |

For MLflow-routed models, the provider detects the model family and drops parameters a backend rejects (e.g. penalties/`seed` for Llama, `reasoningEffort` for Gemini) with an AI SDK warning (`result.warnings`) instead of failing the request. The one exception is `providerOptions.openai.store` on the Responses route, which throws — see [Errors](#errors).

Which ids your branch serves is account-specific during the beta; `GET $NEON_AI_GATEWAY_BASE_URL/v1/models` is the authoritative list.

## Image generation

Available on OpenAI models via the Responses `image_generation` tool (there is no `generateImage()` image-model endpoint). Use `streamText` — streaming returns the image as a `tool-result` part and avoids the gateway's non-streaming response-size cap and read timeout:

```ts
import { streamText } from "ai";
import { neon } from "@neon/ai-sdk-provider";

const result = streamText({
  model: neon("gpt-5-mini"),
  prompt: "Generate an image of a red apple on a wooden table",
  tools: { image: neon.tools.imageGeneration({ partialImages: 3 }) },
});

for await (const part of result.fullStream) {
  if (part.type === "tool-result" && "result" in part.output) {
    const png = Buffer.from(part.output.result as string, "base64");
    // save or use the image
  }
}
```

## Errors

A failed call rejects with the AI SDK's `APICallError`, and `error.message` carries the gateway's own reason rather than the bare HTTP status line:

```ts
try {
  await generateText({ model: neon("gpt-5-mini"), maxOutputTokens: 1, prompt });
} catch (error) {
  error.message;      // "Invalid 'max_output_tokens': integer below minimum
                      //  value. Expected a value >= 16, but got 1 instead."
  error.responseBody; // the gateway's original body, including its error_code
}
```

The gateway answers with more than one error envelope depending on which layer rejected the request, and each route's model parses only its own dialect; the provider re-emits them so the reason always lands on `message`. Two cases are deliberately left alone: an error delivered inside an open stream, and a non-JSON body — both still surface as the status line, with the payload on `error.responseBody`.

Requests that cannot work are refused before they leave, with `UnsupportedFunctionalityError`:

| `providerOptions.openai` | Why |
| --- | --- |
| `store: true` or `store: null` | The Responses route is stateless and never persists items. `null` is not "omitted" — the AI SDK reads it as `true`. |
| `previousResponseId`, `conversation` | Nothing is stored for them to refer to. Send the full message history instead. |

Provider options are namespaced per route, which decides where the SDK reads them from:

| Route | Models | Namespace |
| --- | --- | --- |
| Responses | `gpt-*` (incl. Codex) | `openai` |
| Chat Completions | Gemini, Llama, Qwen, gpt-oss, … | `neon` |
| Anthropic Messages | `claude-*` | `anthropic` |

So `store` is only refused on the Responses route; the same option is ignored elsewhere.

## Limitations

- `generateImage()` and embeddings (`embed` / `embedMany`) are not offered by the gateway and throw `NoSuchModelError`.
- `gpt-oss-*` models return a non-standard ("harmony") response shape on the unified endpoint (`message.content` as an array of reasoning/text parts instead of a string). The provider normalizes this to the OpenAI Chat Completions contract (string `content` + `reasoning_content`) so `generateText`/`streamText` work and reasoning is surfaced. See neondatabase/neon-pkgs#308.
- Results from provider-executed tools (`neon.tools.imageGeneration`, and the other Responses built-ins) are not replayed to the gateway on a later step. Replaying them requires the stored-item reference the gateway cannot resolve, so the AI SDK omits them and reports it in `result.warnings`. Keep anything a later turn depends on in your own application state.
- The gateway serves the Responses API statelessly, so the provider sends `store: false` on that route. Without it the AI SDK assumes OpenAI's stored-item semantics and replays earlier reasoning as `{ type: "item_reference" }`, which the gateway cannot resolve and answers with a 502 — the failure that used to break OpenAI multi-turn tool flows (`generateText` + `stepCountIs`). Because `false` is the only value the gateway accepts, an explicit `store` is refused — see [Errors](#errors).

## End-to-end tests

Against a live branch with AI Gateway enabled:

```bash
cp .env.example .env   # fill NEON_AI_GATEWAY_BASE_URL + NEON_AI_GATEWAY_TOKEN from `neon env pull`
pnpm test:e2e
```

The matrix covers one models.dev `neon` model per family (Anthropic, OpenAI, Codex, Gemini, Meta) across `generateText`, `streamText`, `generateObject`, tool calling, and `neon.tools.imageGeneration`. It also fetches the live `/v1/models` catalog and calls every currently enabled model with both AI SDK 6 and AI SDK 7. Tests are skipped when gateway env vars are absent.
