# @neon/sdk

The official TypeScript SDK for the [Neon API](https://api-docs.neon.tech/reference) — a modern, Fetch-based client generated from Neon's [OpenAPI specification](https://neon.com/api_spec/release/v2.json).

This is the successor to [`@neondatabase/api-client`](https://www.npmjs.com/package/@neondatabase/api-client). It drops the `axios` dependency in favor of the platform `fetch`, so it runs unchanged on Node.js, Bun, Deno, edge runtimes, and the browser.

It ships two layers in one package:

- **`createNeonClient`** — an ergonomic client: authenticate once, get `{ data, error }`
  results (or opt into throwing), automatic retries, readiness polling, auto-pagination,
  and typed errors, organized into resource namespaces.
- **`raw`** — the full generated 1:1 surface: every endpoint as a standalone,
  tree-shakeable function. Also available at the `@neon/sdk/raw` subpath.

## Install

```bash
npm install @neon/sdk
```

Requires Node.js >= 22 (or any runtime with a global `fetch`).

## Usage

Get an API key from the [Neon Console](https://console.neon.tech/app/settings#api-keys), then create a client:

```ts
import { createNeonClient } from "@neon/sdk";

const neon = createNeonClient({ apiKey: process.env.NEON_API_KEY! });

const { data, error } = await neon.projects.list().all();
if (error) {
	// error is a typed NeonError union — switch on error.kind
	throw error;
}
console.log(data);
```

Every method returns `{ data, error }` by default — no `try/catch` required. The `error`
channel carries a typed `NeonError` (`NeonApiError`, `NeonNotFoundError`, …) you can branch
on via `error.kind` or `instanceof`.

### `throwOnError`

Prefer exceptions? Set it on the client (it **narrows the return types** to the bare
resource) or per call:

```ts
const neon = createNeonClient({ apiKey, throwOnError: true });
const project = await neon.projects.get("late-frost-12345"); // Project, throws on error

// or per call, on a default client:
const created = await neon.projects.create({ name: "my-app" }, { throwOnError: true });
```

### Readiness polling

Neon mutations are asynchronous (they return provisioning `operations`). Set
`waitForReadiness` to block until those finish, so the resource is usable when the call
resolves:

```ts
const neon = createNeonClient({ apiKey, waitForReadiness: true });
const { data: project } = await neon.projects.create({ name: "my-app" }); // ready
```

The primitive is also exposed: `await neon.operations.waitFor(operations)`.

### Pagination

`list()` returns a lazy, cursor-paginated list:

```ts
const { data: all } = await neon.projects.list().all(); // every page
for await (const project of neon.projects.list()) { /* stream, throws on error */ }
```

### Dropping to the raw layer

Every endpoint is available 1:1 — reach it as a namespace or via the subpath, reusing the
client's auth through `neon.client`:

```ts
import { raw } from "@neon/sdk";
// or, for guaranteed tree-shaking: import { getProjectBranchSchema } from "@neon/sdk/raw";

const { data } = await raw.getProjectBranchSchema({
	client: neon.client,
	path: { project_id, branch_id: "br-…" },
});
```

## What's exported

- **`createNeonClient`** — the ergonomic client factory.
- **`raw`** — namespace of every generated endpoint function + client primitives (also at `@neon/sdk/raw`).
- **Error classes** — `NeonError`, `NeonApiError`, `NeonNotFoundError`, `NeonAuthError`, `NeonRateLimitError`, `NeonOperationError`, `NeonTimeoutError`, `NeonNetworkError`.
- **Types** — every request/response/error shape, re-exported flat for `import type { … }`.

## Regenerating the client

The client is generated from a vendored, pinned copy of the spec in [`spec/neon-openapi.json`](./spec/neon-openapi.json) using [`@hey-api/openapi-ts`](https://heyapi.dev).

```bash
pnpm --filter @neon/sdk spec:pull   # refresh the vendored spec from neon.com
pnpm --filter @neon/sdk generate     # regenerate src/client
pnpm --filter @neon/sdk build        # typecheck + bundle
```

## License

Apache-2.0
