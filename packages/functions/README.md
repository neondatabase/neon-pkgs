# @neondatabase/functions

Runtime helpers for [Neon Functions](https://neon.com). Currently provides a `waitUntil` primitive for deferring background work past a response.

## Install

```bash
npm install @neondatabase/functions
```

## Usage

The API mirrors [`@vercel/functions`](https://vercel.com/docs/functions/functions-api-reference/vercel-functions-package): import `waitUntil` and call it directly with the promise you want to keep alive.

```ts
import { waitUntil } from "@neondatabase/functions";

export default {
	async fetch(req: Request): Promise<Response> {
		// Fire-and-forget background work that should outlive the response.
		waitUntil(logRequest(req));
		return new Response("ok");
	},
};
```

`waitUntil(promise)` forwards the promise to the Neon Functions runtime, which keeps
the invocation alive until the promise settles (up to the 15-minute `waitUntil` limit).
When no invocation context is in scope — local dev, tests, or any non-Neon host — it is
a **no-op**: the promise is accepted and ignored, so the same code runs everywhere
without branching. Passing a non-`Promise` throws a `TypeError`.

## Runtime integration

The runtime carries the per-invocation context in an `AsyncLocalStorage` and publishes
an accessor at `globalThis[NEON_FUNCTIONS_CONTEXT]` (a
`Symbol.for("@neondatabase/functions/request-context")`) shaped like the providers used
by Vercel and Next.js — a stable object exposing `get()`.

To make `waitUntil` resolve to a given invocation, wrap the handler with
`runWithRequestContext`. This is intended for the Neon Functions runtime; application
code should not need it.

```ts
import { runWithRequestContext } from "@neondatabase/functions";

runWithRequestContext({ waitUntil: realWaitUntil }, () => handler(req));
```

Because the context lives in `AsyncLocalStorage`, concurrent invocations in the same
isolate each see their own context and never clobber one another.
