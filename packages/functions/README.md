# @neondatabase/functions

Runtime helpers for [Neon Functions](https://neon.com). Currently provides a `waitUntil` primitive for deferring background work past a response.

## Install

```bash
npm install @neondatabase/functions
```

## Usage

```ts
import { waitUntil } from "@neondatabase/functions/v1";

export default {
	async fetch(req: Request): Promise<Response> {
		const defer = waitUntil();
		// Fire-and-forget background work that should outlive the response.
		defer(logRequest(req));
		return new Response("ok");
	},
};
```

`waitUntil()` returns a function that forwards the promise to the Neon Functions
runtime, which keeps the invocation alive until the promise settles (up to the
15-minute `waitUntil` limit). When no runtime context is present — local dev, tests,
or any non-Neon host — the returned function is a **no-op**: the promise is accepted
and ignored, so the same code runs everywhere without branching.

Under the hood the runtime publishes its per-invocation context at
`globalThis[NEON_FUNCTIONS_CONTEXT]` (a `Symbol.for("@neondatabase/functions/request-context")`),
mirroring the convention used by Vercel.
