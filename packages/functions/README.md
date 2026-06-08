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

> **Status: not implemented yet.** `waitUntil()` currently returns a no-op function — the
> promise you pass is accepted and ignored. Once the Neon Functions runtime ships, it will
> register the promise with the host so the invocation stays alive until it settles.
