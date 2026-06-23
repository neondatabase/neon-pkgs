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
a **no-op**: the promise is accepted and ignored (it still runs on its own, it just
isn't tracked), so the same code runs everywhere without branching. Passing a
non-`Promise` throws a `TypeError`.

## Runtime integration

The runtime publishes the active invocation context on `globalThis.NEON_REQUEST_CONTEXT`
as a getter that returns the live context object directly — `{ waitUntil }` during an
invocation, `undefined` outside one. `waitUntil` reads that value straight off the
global, so there is nothing for application code to wire up.
