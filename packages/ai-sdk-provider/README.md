# @neon/ai-sdk-provider

Community [Vercel AI SDK](https://ai-sdk.dev) provider for the [Neon](https://neon.com) AI Gateway. Requires **AI SDK v6** (`ai@^6`).

The Neon AI Gateway is **branch-scoped**: each Neon project branch gets its own gateway host, and a platform token authorizes requests for that branch. This provider routes each model to the best gateway endpoint (Anthropic → native Messages, OpenAI → native Responses incl. **Codex**, everything else → unified OpenAI-compatible MLflow endpoint), so a single `neon('claude-...')` call reaches the whole catalog.

Model ids use the canonical Neon (unprefixed) form — `claude-sonnet-4-6`, `gpt-5`, `gemini-2-5-flash` — matching the [`neon` provider on models.dev](https://models.dev). The typed catalog mirrors that provider exactly (kept in sync by a scheduled drift check), plus a few extra gateway-served ids that models.dev doesn't list yet (e.g. Codex, Llama, Qwen). Any other id — including the legacy `databricks-` prefixed form (`databricks-claude-sonnet-4-6`) — is still accepted as a plain string, so existing code keeps working.

## Install

```bash
npm install @neon/ai-sdk-provider ai@^6
```

> **Requirements:** Node.js >= 20.19.

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

Verified across Anthropic, OpenAI (incl. Codex), Google, and Meta models: `generateText` / `streamText` (text, system prompts, multi-turn), tool calling (single and multi-step, generate and stream), `generateObject` / `streamObject`, and image (vision) input.

For MLflow-routed models, the provider detects the model family and drops parameters a backend rejects (e.g. penalties/`seed` for Llama, `reasoningEffort` for Gemini) with an AI SDK warning (`result.warnings`) instead of failing the request.

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

## Limitations

- `generateImage()` and embeddings (`embed` / `embedMany`) are not offered by the gateway and throw `NoSuchModelError`.
- `gpt-oss-*` models return a non-standard ("harmony") response shape on the unified endpoint (`message.content` as an array of reasoning/text parts instead of a string). The provider normalizes this to the OpenAI Chat Completions contract (string `content` + `reasoning_content`) so `generateText`/`streamText` work and reasoning is surfaced. See neondatabase/neon-pkgs#308.
- OpenAI Responses multi-turn tool flows (`generateText` + `stepCountIs`) can return 502 from the gateway; tool calling is covered on Anthropic/Google/Meta in e2e.

## End-to-end tests

Against a live branch with AI Gateway enabled:

```bash
cp .env.example .env   # fill NEON_AI_GATEWAY_BASE_URL + NEON_AI_GATEWAY_TOKEN from `neon env pull`
pnpm test:e2e
```

The matrix covers one models.dev `neon` model per family (Anthropic, OpenAI, Codex, Gemini, Meta) across `generateText`, `streamText`, `generateObject`, tool calling, and `neon.tools.imageGeneration`. Skipped when gateway env vars are absent.
