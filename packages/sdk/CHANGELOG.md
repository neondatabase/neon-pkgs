# @neon/sdk

## 3.1.0

### Minor Changes

- ba16d4d: List, register, and delete branch custom domains on the SDK, tools, and CLI. v1 points a domain at a function.

## 3.0.0

### Major Changes

- 4211669: `branches.create` attaches a read-write endpoint by default; pass `noCompute: true` (tools: `no_compute`) to skip it. `createWithCompute` is now `createAndConnect`. `create` returns the resource without a connection string; `createAndConnect` returns a URI.

## 2.3.0

### Minor Changes

- 9b322e7: Add `branches.resetFromParent` and `branches.compareSchema` to the SDK and as tools (`reset_from_parent_branches`, `compare_schema_branches`).

## 2.2.0

### Minor Changes

- 93b93dc: `sendNeonAuthEmailProviderTest` is now on the generated raw client and in `@neon/tools`. It tests a branch's saved email provider without re-supplying the SMTP password. `sendNeonAuthTestEmail` is deprecated but still available for unsaved full SMTP configs.

## 2.1.0

### Minor Changes

- 5c57d00: Email-server GET responses now use `StandardEmailServerResponse` / `NeonAuthEmailServerConfigResponse`. `StandardEmailServer` is the write shape and its fields are optional, so a Better Auth project can send a partial update. A Stack Auth project still needs all six fields or the API returns 400. Code that read `host` (or the other five fields) off `StandardEmailServer` should switch the annotation to `StandardEmailServerResponse`.

## 2.0.0

### Major Changes

- 4497de8: **Breaking:** `neon.branches.recover` is removed. Neon stopped publishing `POST /projects/{project_id}/branches/{branch_id}/recover` in its OpenAPI spec, so the generated client no longer carries the operation. The endpoint still answers in production, so reach it through the low-level client until it returns to the spec and the wrapper with it:

  ```ts
  import type { BranchRecoverResponse } from "@neon/sdk";

  const { data } = await neon.client.post<{ 200: BranchRecoverResponse }>({
    url: "/projects/{project_id}/branches/{branch_id}/recover",
    path: { project_id: projectId, branch_id: branchId },
  });
  const branch = data?.branch;
  ```

  That envelope carries the API's own error body rather than a `NeonError`, and the `{ 200: … }` wrapper is required — passing `BranchRecoverResponse` directly resolves to a union of its members. `neon.projects.recover` is a different endpoint and is unaffected.

  The same spec refresh adds two namespaces: `neon.projects.members` (`list`, `setRole`, `removeRole`) for the per-project roles of organization members, and `neon.logs` (`query`, `fields`, `fieldValues`) for branch logs.

## 1.5.0

### Minor Changes

- 4fb2ea4: Make cancellation work, and let a call be bounded.

  `CallOptions.signal` was documented on every method but never reached the request: the
  execution core passed only the client into each generated call, so aborting a call let it
  run to completion. The one place a signal did have an effect — interrupting the sleep
  between retries — rejected with a raw `DOMException`, so a client promising
  `{ data, error }` threw, and a `throwOnError` client threw something that was not a
  `NeonError`.

  - **`signal` now reaches the request** on all 91 ergonomic call sites, plus paginated
    `list()`, and the multi-request `postgres.connectionString` resolver.
  - **`requestTimeoutMs`** bounds a request and its retries, on the client or per call.
    Unset by default, so existing calls stay unbounded; pass `Infinity` on a call to opt out
    of a client-wide value. It is separate from `wait.timeoutMs`, which budgets readiness
    polling. Invalid values are rejected at construction rather than silently firing
    immediately.
  - **New `NeonAbortError`** (`kind: "aborted"`) for caller cancellation, distinct from
    `NeonTimeoutError` (`kind: "timeout"`) because a timeout is worth retrying and a
    cancellation is not. Both arrive through the result envelope; neither escapes as a
    `DOMException`.
  - **Paginated `list()` methods accept per-call options** after their query, so a walk can
    be cancelled or bounded like any other call. A deadline covers one consumption of the
    list rather than each page.
  - **`Retry-After` is honoured, not capped.** It previously multiplied straight into a
    sleep, so `Retry-After: 3600` parked a call for an hour; the HTTP-date form parsed as
    `NaN` and fell through to generated backoff, retrying far sooner than instructed. The
    delay is never shortened now — when honouring it would exceed 10s or the remaining
    deadline, the SDK stops retrying and surfaces the real `423`/`429`/`503`.

  Cancellation is classified from the SDK's own deadline state rather than by matching error
  names, because the generated client reports auth, serialization, interceptor, transport and
  parsing faults through one channel. A transport failure that merely looks like an abort
  stays a `NeonNetworkError`.

  **Compile-time note.** `NeonErrorKind` gains `"aborted"`. Widening that union can break a
  consumer whose `switch` over `error.kind` is exhaustive with a `never` check — such code
  stops compiling until the new case is handled. This ships as a minor deliberately: an error
  taxonomy has to be able to grow, and treating every new kind as breaking would either
  freeze it or force a major for each addition. Nothing changes at runtime for existing
  kinds, and no existing kind changes meaning.

### Patch Changes

- c8e1e74: Close three gaps in the cancellation and deadline work.

  - **A malformed `Retry-After` no longer causes an immediate retry.** Requiring
    `/^\d+$/` for delta-seconds sent invalid values on to `Date.parse`, which reads `-1`,
    `1.5` and `+5` as dates in 2001. Those are in the past, so the delay clamped to `0` and
    the SDK retried at once — the opposite of what the header asks. A numeric-looking value
    that is not valid delta-seconds is now rejected outright.
  - **A `wait.timeoutMs` larger than `2147483647` no longer expires almost immediately.**
    `setTimeout` collapses any delay past that to 1ms (`TimeoutOverflowWarning`), and
    readiness budgets have always accepted arbitrarily large values. Deadline timers are
    re-armed in chunks, so a large budget behaves as written.
  - **A `snapshots.restore` `preview` callback that throws no longer escapes the result
    contract.** A callback cooperating with its signal throws an `AbortError`, which
    propagated out of a client that promised `{ data, error }`. A throw is now reported as
    `NeonAbortError` when the signal fired and as a `client`-kind `NeonError` otherwise,
    both saying the restored branch is left un-finalized.

  Also: a readiness timeout message counts the operations still outstanding rather than the
  round's starting total, and the readiness tests now cancel and expire during an in-flight
  poll instead of only between polls.

## 1.4.1

### Patch Changes

- 923ebbb: Stop publishing vitest and its transitive dependencies inside the package.

  `dist/node_modules/` held 743KB of `vitest`, `chai`, `expect-type`, `loupe` and
  `tinyrainbow` — 28% of the unpacked tarball — because `src/neon/client.test-d.ts`
  imports `expectTypeOf` and the tsdown `entry` globs excluded only `*.test.ts`, not
  `*.test-d.ts`. tsdown externalizes what `dependencies` lists and inlines everything
  else, so a devDependency import from any matched file gets copied into the output.
  `@neon/sdk` is published as zero-dependency, so nothing belongs there.

  The globs now match the exclusions `@neon/config` and `@neon/env` already used, and
  `pnpm build` fails if the artifact regresses: `scripts/check-dist.mjs` rejects a
  `dist/` that carries bundled dependencies, emitted test files, a non-empty
  `dependencies` map, or a bare runtime import a consumer could not resolve.

  No API change.

## 1.4.0

### Minor Changes

- 630f102: Make errors diagnosable in production builds.

  - Error class names are now string literals rather than derived from the constructor, so they survive bundling. Previously every error surfaced as `s` or `r` in a minified consumer, which broke log reading and error-tracker grouping.
  - `NeonNetworkError` gains a `reason` field carrying the most specific transport reason available (an `errno` code such as `ECONNRESET`, otherwise the innermost non-empty message), and interpolates it into `message`. A DNS failure, a reset connection, and a timeout no longer share one indistinguishable string.

## 1.3.0

### Minor Changes

- Refresh the vendored Neon OpenAPI spec and regenerated client, and narrow the backup-schedule `frequency` in the ergonomic layer.

  - **Regenerated from the latest spec:** `OperationAction` gains `epc_sync` (additive), and the backup-schedule update endpoint + `BackupScheduleItem.frequency` descriptions now document only `daily` / `weekly` / `monthly` (dropping `hourly` / `yearly`). The generated `frequency` stays `string` — the spec documents the allowed values in prose, not as an `enum` — so the type-level narrowing lives in the ergonomic layer.
  - **Ergonomic layer:** `snapshots.setSchedule` now takes a `SetScheduleInput` whose entries' `frequency` is narrowed to the new `SnapshotFrequency` union (`"daily" | "weekly" | "monthly"`), so unsupported values are rejected at compile time instead of by the API. `getSchedule` still returns the server-controlled `BackupSchedule` unchanged (received data stays wide).
  - **New exported types:** `SnapshotFrequency`, `BackupScheduleItemInput`, `SetScheduleInput`, plus the previously-unexported `UpdateSnapshotInput`.

  Snapshot expiration (`expiresAt` / clearing with `null`) already shipped in 1.1.0 and is unchanged here.

## 1.2.0

### Minor Changes

- a8e4937: Refresh the vendored Neon OpenAPI spec and regenerated client to track the live API.

  - `PgVersion` now allows major version `19` (max bumped `18` → `19`). Postgres 19 is being rolled out and is only accepted in regions where it has been enabled; requesting it elsewhere returns an error. The type description is updated to reflect GA vs. rollout versions.
  - `OperationAction` gains two new values, `tenant_detach_safekeepers` and `tenant_attach_safekeepers`.

  No wrapped operations were added or removed (163 operations, coverage unchanged), so the ergonomic `createNeonClient` surface is unaffected — this is a pure type/spec refresh.

## 1.1.1

### Patch Changes

- 22d5cdd: Reference the `neon` CLI over `neonctl` in user-facing output and docs. The CLI
  ships both the `neon` and `neonctl` binaries; `neonctl` keeps working as an
  alias, but `neon init` now emits `neon …` commands, status messages, and
  agent-facing prompts using the cleaner `neon` name, and the package READMEs
  document `neon`. Internal package install/version checks and the
  `~/.config/neonctl/` config path are unchanged.

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
