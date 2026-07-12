# @neon/sdk

## 1.1.0

### Minor Changes

- dba7d3f: Refresh the vendored Neon OpenAPI spec and regenerated client, and surface the new snapshot expiration control ergonomically.

  - `snapshots.update(projectId, snapshotId, input)` now accepts `expiresAt` (ISO 8601). Omit it to leave the current expiration unchanged, pass a future timestamp to set an absolute expiration, or pass `null` to clear it so the snapshot never expires — matching the camelCase `expiresAt` already used by `snapshots.create`.
  - Regenerated types pick up the renamed `ProjectPermissionLevel` values (`VIEWER` / `EDITOR` / `ADMIN`, previously `CAN_VIEW` / `CAN_EDIT` / `CAN_MANAGE`) to track the live API.

## 1.0.0

### Major Changes

- d511ca4: v1.0.0 — unify the raw layer on the ergonomic result contract, and wrap the high-value
  auth/permissions surface.

  **Raw layer (breaking).** Every `raw.*` operation (and `@neon/sdk/raw`) now speaks the same
  contract as `createNeonClient`: it resolves to a `{ data, error }` `NeonResult` by default,
  or the bare resource when you pass `throwOnError: true` (throwing the typed `NeonError`
  hierarchy). The hey-api `{ data, request, response }` envelope and the `responseStyle`
  switch have been removed from the public raw surface — `throwOnError` is the only switch and
  the return type always tracks it. This fixes the two long-standing raw-layer papercuts:
  `throwOnError` now really returns the bare resource, and the success type narrows correctly.

  Migration: replace `const r = await raw.getProject({ …, throwOnError: true, responseStyle: "data" })`
  with `const project = await raw.getProject({ …, throwOnError: true })`, and drop any
  `unwrapRaw`/`responseStyle` workarounds. Default (non-throwing) calls now return
  `{ data, error }` with a typed `NeonError` instead of the raw `GeneralError` envelope.

  **New ergonomic namespaces.** `neon.auth` (branch-scoped Neon Auth: `get`/`create`/`disable`/
  `updateConfig`, plus `auth.oauthProviders`, `auth.trustedDomains`, `auth.users`),
  `neon.projects.permissions` (`list`/`grant`/`revoke`), `neon.projects.recover`, and
  `neon.postgres.endpoints.listByBranch`.

### Minor Changes

- 9b2794e: Refresh the OpenAPI spec and add ergonomic wrappers for beta branch APIs (storage, buckets, functions, credentials, AI gateway, branch recovery).

## 0.2.0

### Minor Changes

- Support Node.js >= 20.19 at runtime. Every published package now declares
  `engines.node: ">=20.19.0"` — the real floor of its dependency tree — instead of `>=22`, so the
  packages install and run cleanly on Node 20 without any dependency downgrades (`neonctl` moves
  from `>=20.18.1` to `>=20.19.0` to match `chokidar@5`). Contributing to the repo still requires
  Node 22 (pnpm + SDK codegen); see `CONTRIBUTING.md`.

## 0.1.0

### Minor Changes

- 21a7202: Initial release of `@neon/sdk` — the official TypeScript SDK for the Neon API, and the successor to `@neondatabase/api-client`.

  Generated from Neon's [OpenAPI specification](https://neon.com/api_spec/release/v2.json) with [`@hey-api/openapi-ts`](https://heyapi.dev) on top of a Fetch-based client (no `axios`), so it runs unchanged on Node.js, Bun, Deno, edge runtimes, and the browser. Ships as a tree-shakeable, ESM-only package (`sideEffects: false`).

  Two layers, one package:

  - **`createNeonClient`** — an ergonomic client: authenticate once, `{ data, error }` results (or `throwOnError`, which narrows the return types), automatic retries on safe statuses, readiness polling (`waitForReadiness` + `operations.waitFor`), auto-pagination, and a typed `NeonError` hierarchy — organized into resource namespaces (`projects`, `operations`; more to follow).
  - **`raw`** — the full generated 1:1 surface: every endpoint as a standalone, tree-shakeable function plus client primitives. Available as the `raw` namespace and at the `@neon/sdk/raw` subpath. All request/response/error types are re-exported flat.

  The codegen reclassifies the spec's `default` error responses as `4XX` so success `data` types stay clean (no `GeneralError` leaking onto the data channel). A `coverage` test guards against drift: it fails CI whenever the generated operation set changes, forcing each new endpoint to be wrapped or consciously left raw-only.
