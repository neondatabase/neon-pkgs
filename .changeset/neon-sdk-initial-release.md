---
"@neondatabase/sdk": minor
---

Initial release of `@neondatabase/sdk` — the official TypeScript SDK for the Neon API, and the successor to `@neondatabase/api-client`.

- Generated from Neon's [OpenAPI specification](https://neon.com/api_spec/release/v2.json) with [`@hey-api/openapi-ts`](https://heyapi.dev) on top of a Fetch-based client. It drops the `axios` dependency, so it runs unchanged on Node.js, Bun, Deno, edge runtimes, and the browser.
- Every endpoint is exposed as an individually importable, tree-shakeable function (`listProjects`, `createProject`, `createProjectBranch`, …), alongside all request/response/error types and the client primitives (`createClient`, `createConfig`, and the preconfigured default `client`).
- The codegen reclassifies the spec's `default` error responses as `4XX` so success `data` types stay clean (no `GeneralError` leaking onto the data channel).
