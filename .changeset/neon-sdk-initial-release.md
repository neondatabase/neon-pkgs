---
"@neon/sdk": minor
---

Initial release of `@neon/sdk` — the official TypeScript SDK for the Neon API, and the successor to `@neondatabase/api-client`.

Generated from Neon's [OpenAPI specification](https://neon.com/api_spec/release/v2.json) with [`@hey-api/openapi-ts`](https://heyapi.dev) on top of a Fetch-based client (no `axios`), so it runs unchanged on Node.js, Bun, Deno, edge runtimes, and the browser. Ships as a tree-shakeable, ESM-only package (`sideEffects: false`).

Two layers, one package:

- **`createNeonClient`** — an ergonomic client: authenticate once, `{ data, error }` results (or `throwOnError`, which narrows the return types), automatic retries on safe statuses, readiness polling (`waitForReadiness` + `operations.waitFor`), auto-pagination, and a typed `NeonError` hierarchy — organized into resource namespaces (`projects`, `operations`; more to follow).
- **`raw`** — the full generated 1:1 surface: every endpoint as a standalone, tree-shakeable function plus client primitives. Available as the `raw` namespace and at the `@neon/sdk/raw` subpath. All request/response/error types are re-exported flat.

The codegen reclassifies the spec's `default` error responses as `4XX` so success `data` types stay clean (no `GeneralError` leaking onto the data channel). A `coverage` test guards against drift: it fails CI whenever the generated operation set changes, forcing each new endpoint to be wrapped or consciously left raw-only.
