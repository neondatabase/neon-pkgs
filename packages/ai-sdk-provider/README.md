# @neondatabase/ai-sdk-provider

Community [Vercel AI SDK](https://ai-sdk.dev) provider for the [Neon](https://neon.com) AI Gateway.

The Neon AI Gateway is **branch-scoped**: each Neon project branch gets its own gateway host, and a platform token authorizes requests for that branch. This provider routes each model to the best gateway endpoint (Anthropic → native Messages, OpenAI → native Responses incl. **Codex**, everything else → unified OpenAI-compatible MLflow endpoint), so a single `neon('databricks-...')` call reaches the whole `databricks-*` catalog.

## Install

```bash
npm install @neondatabase/ai-sdk-provider
```

## Configuration

The gateway URL is branch-scoped, so both values come from the Neon Console (your project → a branch → **AI Gateway** tab), or from `neonctl env pull` / `neon dev`:

```bash
NEON_AI_GATEWAY_BASE_URL="https://<branch-id>-api.ai.<region>.aws.neon.tech"
NEON_AI_GATEWAY_TOKEN="nt_live_..."
```

## Usage

```ts
import { neon } from "@neondatabase/ai-sdk-provider/v1";
import { generateText } from "ai";

// Reads NEON_AI_GATEWAY_BASE_URL + NEON_AI_GATEWAY_TOKEN from the environment.
const { text } = await generateText({
  model: neon("databricks-claude-haiku-4-5"), // or 'databricks-gpt-5-3-codex', etc.
  prompt: "Summarize Postgres for me.",
});
```

Or configure explicitly with `createNeon`:

```ts
import { createNeon } from "@neondatabase/ai-sdk-provider/v1";

const neon = createNeon({
  baseURL: process.env.NEON_AI_GATEWAY_BASE_URL,
  apiKey: process.env.NEON_AI_GATEWAY_TOKEN,
});
```

## Routing

| Model family | Endpoint | Why |
| --- | --- | --- |
| Anthropic (`databricks-claude-*`) | native Messages API | streaming structured output + native reasoning |
| OpenAI (`databricks-gpt-*`, `*-codex`) | native Responses API | Codex (native-only), native reasoning, image-gen tool |
| Everything else (Gemini, Llama, Qwen, gpt-oss, ...) | unified MLflow endpoint | broad coverage; Gemini is here because its native endpoint does not support streaming |

## Capabilities

Verified across Anthropic, OpenAI (incl. Codex), Google, and Meta models: `generateText` / `streamText` (text, system prompts, multi-turn), tool calling (single and multi-step, generate and stream), `generateObject` / `streamObject`, and image (vision) input.

For MLflow-routed models, the provider detects the model family and drops parameters a backend rejects (e.g. penalties/`seed` for Llama, `reasoningEffort` for Gemini) with an AI SDK warning (`result.warnings`) instead of failing the request.

## Image generation

Available on OpenAI models via the Responses `image_generation` tool (there is no `generateImage()` image-model endpoint). Use `streamText` — streaming returns the image as a `tool-result` part and avoids the gateway's non-streaming response-size cap and read timeout:

```ts
import { streamText } from "ai";
import { neon } from "@neondatabase/ai-sdk-provider/v1";
import { imageGeneration } from "@ai-sdk/openai/internal";

const result = streamText({
  model: neon("databricks-gpt-5-mini"),
  prompt: "Generate an image of a red apple on a wooden table",
  tools: { image: imageGeneration({ partialImages: 3 }) },
});

for await (const part of result.fullStream) {
  if (part.type === "tool-result" && "result" in part.output) {
    const png = Buffer.from(part.output.result as string, "base64");
    // save or use the image
  }
}
```

## Limitations

- `generateImage()` and embeddings (`embed` / `embedMany`) are not offered by the gateway and throw `NoSuchModelError`.
- `gpt-oss-*` models return a non-standard ("harmony") response shape on the unified endpoint and are not fully supported.

## Versioning

Import from `@neondatabase/ai-sdk-provider/v1` to pin to a specific major. The default entry re-exports the latest stable version.
