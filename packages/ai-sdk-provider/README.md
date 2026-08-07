# @neon/ai-sdk-provider

Community [Vercel AI SDK](https://ai-sdk.dev) provider for the [Neon](https://neon.com) AI Gateway. Supports **AI SDK v6 and v7** (`ai@^6` or `ai@^7`).

The Neon AI Gateway is **branch-scoped**: each Neon project branch gets its own gateway host, and a platform token authorizes requests for that branch. Use the same `neon(modelId)` API across the branch's model catalog; the provider selects Anthropic Messages, OpenAI Responses, or Chat Completions for each model.

Use canonical model ids such as `gpt-5-mini`, `llama-4-maverick`, and `gemini-3-flash`, matching the [`neon` provider on models.dev](https://models.dev). The typed catalog includes the known model ids, and arbitrary strings are accepted so newly available models work before the types update.

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
  model: neon("gpt-5-mini"), // or "llama-4-maverick", "gemini-3-flash", …
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
| Anthropic (`claude-*`) | Messages API | Anthropic tools, structured output, and reasoning |
| OpenAI (`gpt-*`, `*-codex`) | Responses API | Codex, reasoning, and built-in tools such as image generation |
| Everything else (Gemini, Llama, Qwen, gpt-oss, ...) | Chat Completions API | one streaming interface across the remaining model families |

Routing matches on the model id.

## Capabilities

`generateText` and `streamText` work with any model available to your branch. `generateObject`, `streamObject`, and single- or multi-step tool calls work with OpenAI (including Codex), Meta, Alibaba, Zhipu AI, and Thinking Machines models. Gemini currently supports `generateText` and `streamText`; structured output and multi-step tools are not supported. Vision input works on models that accept images.

Claude models use the Messages API. On both that route and Chat Completions the provider removes call options the gateway rejects and reports each one in `result.warnings` instead of failing the request — see [Dropped call options](#dropped-call-options). Unsupported Responses API storage options throw before a request is sent — see [Errors](#errors).

Which ids your branch serves is account-specific during the beta; `GET $NEON_AI_GATEWAY_BASE_URL/v1/models` is the authoritative list. `NeonChatModelId` accepts any string, so an id this package has not caught up with still works — and, equally, an id the gateway has retired still type-checks and fails at the gateway instead.

### Dropped call options

Upstream backends behind the gateway accept different subsets of the OpenAI-style parameters the AI SDK emits, and sending one an upstream rejects is a hard `400`. The provider drops those before the request and records a warning in `result.warnings`, so a call succeeds instead of failing on a parameter you passed in good faith.

These rules apply on the Anthropic Messages and Chat Completions routes. On the Responses route (every `gpt-*` id) penalties, `seed` and `stopSequences` are left to the upstream OpenAI model's own stripping, but `temperature` and `topP` are handled here, because the gateway rejects them on the four ids listed below.

| Models | Dropped |
| --- | --- |
| Claude 4.7 and newer (`claude-opus-4-7`, `claude-opus-4-8`, `claude-opus-5`, `claude-sonnet-5`, `claude-fable-5`) | `temperature`, `topP` |
| All Claude | `frequencyPenalty`, `presencePenalty`, `seed`, `reasoningEffort`, and `topP` when you set both `temperature` and `topP` (Anthropic accepts only one) |
| `gpt-oss` | `frequencyPenalty`, `presencePenalty`, `seed`, `stopSequences` |
| Qwen, Gemma | `frequencyPenalty`, `presencePenalty`, `seed` |
| `glm-5-2`, `inkling`, `kimi-k3` | `frequencyPenalty`, `presencePenalty` |
| Meta Llama | `frequencyPenalty`, `presencePenalty`, `seed` |
| `gemini-3-5-flash-lite` | `frequencyPenalty`, `presencePenalty` |
| `gemini-3-6-flash` | `temperature`, `topP`, `frequencyPenalty`, `presencePenalty` |
| Every other Gemini | nothing |
| `gpt-5`, `gpt-5-mini`, `gpt-5-nano`, `gpt-5-5-pro` | `temperature`, `topP` |

**`temperature` on a Claude 5 model therefore has no effect.** That is the gateway's behaviour, not a provider choice; sending it returns `does not support the temperature parameter`. Steer those models with Anthropic's own effort control instead — note that this is `effort`, not the OpenAI-style `reasoningEffort`, which every Claude id drops:

```typescript
await generateText({
  model: neon('claude-opus-5'),
  prompt: 'Plan a schema migration.',
  providerOptions: { anthropic: { effort: 'high' } }, // low | medium | high | xhigh | max
});
```

Query the rules directly rather than hardcoding them:

```typescript
import { getNeonModelCapabilities } from '@neon/ai-sdk-provider';

getNeonModelCapabilities('claude-opus-5').supportsTemperature; // false
getNeonModelCapabilities('glm-5-2').supportsPenalties; // false
```

**The rules are per model, not per family.** Two Gemini ids reject penalties while their siblings accept them, and `gemini-3-6-flash` rejects `temperature` and `topP` outright, so reading a row for "Gemini" is not enough — check the id. Every entry above is measured against the gateway rather than inherited from the upstream provider's own documentation, which disagrees in both directions.

A model none of these rules match is left untouched, so a brand-new id gets the gateway's own error rather than a guess. That is also why the table can lag: an id added since the last release inherits the permissive default until someone measures it.

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

### Edit a generated image

The gateway does not support stored Responses API items (`store: true`, `previousResponseId`, or `conversation`), which the Responses API uses to reuse tool results across turns. For image edits, pass the returned bytes back as image input; otherwise the model does not receive the original image and generates a new one.

```ts
const first = await generateText({
  model: neon("gpt-5-mini"),
  prompt: "Generate an image of a plain red square.",
  tools: { image_generation: neon.tools.imageGeneration({ outputFormat: "jpeg" }) },
});

const generated = first.steps
  .flatMap((step) => step.toolResults)
  .find((result) => result.toolName === "image_generation");
const output = generated?.output;
if (
  !output ||
  typeof output !== "object" ||
  !("result" in output) ||
  typeof output.result !== "string"
) {
  throw new Error("Image generation did not return image bytes.");
}

// Pass it back as image content, not as conversation history.
await generateText({
  model: neon("gpt-5-mini"),
  tools: { image_generation: neon.tools.imageGeneration({ outputFormat: "jpeg" }) },
  messages: [
    {
      role: "user",
      content: [
        { type: "image", image: output.result, mediaType: "image/jpeg" },
        { type: "text", text: "Make that same square blue instead." },
      ],
    },
  ],
});
```

The same stateless limitation applies to other built-in Responses tools such as web search and code interpreter.

## Errors

A failed call rejects with the AI SDK's `APICallError`, and `error.message` carries the gateway's own reason rather than the bare HTTP status line:

```ts
import { APICallError, generateText } from "ai";

try {
  await generateText({ model: neon("gpt-5-mini"), maxOutputTokens: 1, prompt });
} catch (error) {
  if (APICallError.isInstance(error)) {
    error.message;      // "Invalid 'max_output_tokens': integer below minimum
                        //  value. Expected a value >= 16, but got 1 instead."
    error.responseBody; // the gateway's original body, including its error_code
  }
}
```

The provider normalizes JSON error responses so the gateway's reason lands on `error.message`. Errors delivered inside an open stream and non-JSON responses keep the HTTP status line; inspect `error.responseBody` for their payload.

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

- The gateway does not offer image or embedding model endpoints, so `generateImage()`, `embed()`, and `embedMany()` throw `NoSuchModelError`. Image generation is available through the Responses API's built-in `image_generation` tool with `neon.tools.imageGeneration()`.
- Results from provider-executed tools (`neon.tools.imageGeneration`, and the other Responses built-ins) are not replayed to the gateway on a later step — see [Edit a generated image](#edit-a-generated-image).
- The Responses route is stateless, so the provider sends `store: false` and refuses `store: true`, `store: null`, `previousResponseId`, or `conversation` — see [Errors](#errors).

## End-to-end tests

Against a live branch with AI Gateway enabled:

```bash
cp .env.example .env   # fill NEON_AI_GATEWAY_BASE_URL + NEON_AI_GATEWAY_TOKEN from `neon env pull`
pnpm test:e2e
```

The matrix covers one models.dev `neon` model per family (Anthropic, OpenAI, Codex, Gemini, Meta, Alibaba, Zhipu, Thinking Machines) across `generateText`, `streamText`, `generateObject`, tool calling, and `neon.tools.imageGeneration`. `generateObject` and tool calling run on the subset of families where they are verified (see [Capabilities](#capabilities)); a family whose representative id the branch does not serve is skipped rather than failed. It also fetches the live `/v1/models` catalog and calls every currently enabled model with both AI SDK 6 and AI SDK 7. Tests are skipped when gateway env vars are absent.
