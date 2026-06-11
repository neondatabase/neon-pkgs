# @neondatabase/ai-sdk-provider

Community [Vercel AI SDK](https://ai-sdk.dev) provider for the [Neon](https://neon.com) AI Gateway.

## Install

```bash
npm install @neondatabase/ai-sdk-provider
```

## Usage

```ts
import { createNeon } from "@neondatabase/ai-sdk-provider/v1";

const neon = createNeon({
	baseURL: process.env.NEON_AI_GATEWAY_BASE_URL,
	apiKey: process.env.NEON_AI_GATEWAY_TOKEN,
});
```

> **Status: not implemented yet.** This `0.0.0` release only reserves the
> `@neondatabase/ai-sdk-provider` package name — `createNeon()` currently throws. The Neon AI
> Gateway integration ships in a follow-up release.
