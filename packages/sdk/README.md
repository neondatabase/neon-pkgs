# @neon/sdk

The official TypeScript SDK for the [Neon API](https://neon.com/docs/reference/api) — a modern, **Fetch-based**, **zero-dependency**, ESM-only client generated from Neon's [OpenAPI specification](https://neon.com/api_spec/release/v2.json). Successor to [`@neondatabase/api-client`](https://www.npmjs.com/package/@neondatabase/api-client).

Two layers, one package:

- **`createNeonClient`** — an ergonomic client (auth once, `{ data, error }` results, typed errors, retries, readiness polling, auto-pagination, workflows), organized into resource namespaces.
- **`raw`** — the full generated 1:1 surface: every endpoint as a standalone, tree-shakeable function. Also at the `@neon/sdk/raw` subpath.

---

## Install

```bash
npm install @neon/sdk
```

Requires Node.js ≥ 20.19 (or any runtime with a global `fetch` — Bun, Deno, edge, browser).

## Quick start

```ts
import { createNeonClient } from "@neon/sdk";

const neon = createNeonClient({ apiKey: process.env.NEON_API_KEY! });

// create a project and get a ready-to-use connection string
const { data, error } = await neon.projects.createAndConnect({ name: "my-app" });
if (error) throw error;
const { project, connectionString } = data;
```

---

## Client configuration

`createNeonClient(config)`:

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `apiKey` | `string \| (() => string \| Promise<string>)` | — (required) | Neon API key, or a function returning it (sync/async). Sent as a Bearer token. |
| `throwOnError` | `boolean` | `false` | When `true`, methods return the resource directly and **throw** on error. When `false`, they return `{ data, error }`. **Narrows return types** at the type level. |
| `waitForReadiness` | `boolean` | `false` | When `true`, mutations block until their provisioning `operations` finish, so the returned resource is ready to use. |
| `wait` | `{ pollIntervalMs?: number; timeoutMs?: number }` | `1000` / `300000` | Tuning for the readiness poller. |
| `retries` | `number` | `2` | Automatic retries on always-safe statuses (`423`, `429`, `503`) with backoff. |
| `requestTimeoutMs` | `number` | — (unbounded) | Deadline for a request **and** its retries. Aborts the request and resolves with a `NeonTimeoutError`. Pass `Infinity` per call to opt out of a client-wide value. Separate from `wait.timeoutMs`. |
| `orgId` | `string` | — | Default organization, applied to project create/list and as the transfer source org. Overridable per call. |
| `baseUrl` | `string` | `https://console.neon.tech/api/v2` | Override the API base URL. |
| `fetch` | `typeof fetch` | global `fetch` | Custom fetch implementation (proxies, tests, non-global runtimes). |

Every option except `apiKey` is also accepted **per call** via the last `options` argument (`{ throwOnError?, waitForReadiness?, requestTimeoutMs?, signal? }`), overriding the client default. Paginated methods take it too, after their query.

## The result model

By default every method resolves to a discriminated `{ data, error }` envelope — no `try/catch` needed:

```ts
const { data, error } = await neon.projects.get("late-frost-12345");
if (error) {
  // error is a typed NeonError union
  return;
}
data; // narrowed to Project
```

Set `throwOnError` (on the client or per call) to get the bare resource and throw instead — and the **return types narrow accordingly**:

```ts
const neon = createNeonClient({ apiKey, throwOnError: true });
const project = await neon.projects.get("…");                 // Project (throws on error)
const res     = await neon.projects.get("…", { throwOnError: false }); // { data, error }
```

## Errors

The `error` channel carries a typed hierarchy (all `Error` subclasses with a `kind` discriminant); the same value is thrown when `throwOnError` is set.

| Class | `kind` | Notable fields |
| --- | --- | --- |
| `NeonError` | (base) | `message`, `kind` |
| `NeonApiError` | `"api"` | `status`, `code`, `requestId`, `response`, `body` |
| `NeonNotFoundError` | `"not_found"` | (404) — extends `NeonApiError` |
| `NeonAuthError` | `"auth"` | (401/403) |
| `NeonRateLimitError` | `"rate_limit"` | (429, after retries) |
| `NeonOperationError` | `"operation"` | `operationId`, `status` — an awaited operation failed |
| `NeonTimeoutError` | `"timeout"` | a deadline was exceeded — `requestTimeoutMs`, or the readiness/wait budget |
| `NeonAbortError` | `"aborted"` | the caller's `signal` fired |
| `NeonNetworkError` | `"network"` | `reason` — transport failure (no response) |
| `NeonError` | `"client"` | SDK-side errors (e.g. ambiguous connection-string selection) |

```ts
const { error } = await neon.branches.get(pid, "nope");
if (error?.kind === "not_found") { /* … */ }
```

Branch on `kind` rather than `name` or `message`. `name` is a stable string literal on every
class, so it survives bundling, but `message` is not a contract.

`kind` tells you what happened. To reach a subclass's **own** fields — `NeonNetworkError.reason`,
`NeonApiError.body` — narrow with `instanceof`: the result envelope types `error` as the base
`NeonError`, so a `kind` check alone does not make those properties visible.

`NeonNetworkError.reason` carries the most specific reason the platform gave — an `errno`
code such as `ECONNRESET` when one is available, otherwise the innermost non-empty message.
It is also interpolated into `message`, so transport faults are distinguishable in logs and
error trackers instead of collapsing onto one string:

```ts
import { NeonNetworkError } from "@neon/sdk";

const { error } = await neon.projects.get(id);
if (error instanceof NeonNetworkError) {
  error.reason; // "ECONNRESET"
  error.message; // 'Network error: no response received from the Neon API (ECONNRESET).'
}
```

Validating ids and other path parameters before passing them in is the caller's
responsibility. An empty path parameter builds a URL with an empty segment, which the Neon
API answers with a redirect rather than a `400`; that can surface as a `"network"` error
rather than anything that names the argument.

## Cancellation & deadlines

Pass a `signal` to cancel a call, or `requestTimeoutMs` to bound it. Both arrive on the
`error` channel as typed errors — a cancelled call never rejects with a raw `DOMException`,
and a `throwOnError` client throws the same `NeonError` subclass it would have returned:

```ts
const controller = new AbortController();
const { error } = await neon.projects.list().all();

// cancel in-flight work (a user navigating away, a request handler aborting)
const result = await neon.projects.get(id, { signal: controller.signal });
if (result.error?.kind === "aborted") { /* the caller stopped it */ }

// bound a call, on the client or per call
const neon = createNeonClient({ apiKey, requestTimeoutMs: 30_000 });
const slow = await neon.projects.get(id, { requestTimeoutMs: 5_000 });
if (slow.error?.kind === "timeout") { /* the deadline was exceeded */ }

// opt a single call back out of a client-wide deadline
await neon.storage.objects.get(projectId, branchId, "bucket", "big.tar", {
  requestTimeoutMs: Number.POSITIVE_INFINITY,
});
```

`"aborted"` and `"timeout"` are deliberately distinct: a timeout is worth retrying, a
cancellation is not.

`requestTimeoutMs` must be a positive number of milliseconds up to `2147483647`, or
`Infinity`. Anything else — `0`, a negative, `NaN`, or a value past that range — is
rejected with a `client`-kind error when the client is created or the call is made, rather
than silently becoming an instant timeout or no timeout at all.

Cancellation reaches everything the SDK controls: the request and its retries, readiness
polling, each page of a paginated walk, and the multi-request `postgres.connectionString`
resolver. The one thing it cannot interrupt is your own code — a `snapshots.restore`
`preview` callback receives the signal as its second argument so it can cooperate, and the
restore is left un-finalized if the call is cancelled around it.

**Calls are unbounded unless you set `requestTimeoutMs`**, which is what they have always
been. `requestTimeoutMs` covers one request and all of its retries; readiness polling keeps
its own budget in `wait.timeoutMs`, so setting one does not silently cap the other.

`retries` interacts with it: a `Retry-After` is never shortened, because retrying earlier
than the server asked is worse than not retrying. If honouring it would take longer than
10s or than the remaining deadline, the SDK stops retrying and hands you the real
`423`/`429`/`503` instead of waiting or reporting a timeout that hides the status.

## Pagination

Cursor-paginated `list()` methods return a lazy `Paginated<T>`:

```ts
const { data: all } = await neon.projects.list().all();      // every page → { data, error }
const { data: page } = await neon.projects.list().page();    // one page
for await (const project of neon.projects.list()) { … }      // stream; throws on a page error

// per-call options come after the query
const { data } = await neon.projects
  .list({ search: "prod" }, { signal, requestTimeoutMs: 10_000 })
  .all();
```

A deadline covers **one consumption** — a whole `all()`, or a whole iteration — rather than
each page, since that is the unit a caller waits on. A `Paginated` is lazy and reusable, so
consuming it twice gets a fresh deadline each time.

## Readiness & workflows

Neon mutations are asynchronous (they return `operations`). `waitForReadiness` blocks until they settle. `projects.create`, `branches.create`, and the `createAndConnect` workflows default it on. The connect workflows also hand back a connection string. The primitive is `neon.operations.waitFor(operations)`.

---

## API reference

Legend: **[P]** returns `Paginated<T>` · **[W]** workflow (multi-step) · **→void** resolves to `void`. Unless noted, methods take an optional trailing `options` arg and resolve to the resource (or `{ data, error }`).

### `neon.projects`

| Method | Returns | Notes |
| --- | --- | --- |
| `list(query?)` | **[P]** `ProjectListItem` | `query`: `{ search?, org_id?, limit? }` (cursor managed for you) |
| `get(id)` | `Project` | |
| `create(input?)` | `Project` | API always provisions default-branch compute. No connection string. Readiness polling on by default. `input`: `{ name?, region_id?, pg_version?, org_id?, autoscaling_limit_min_cu?, autoscaling_limit_max_cu?, settings? }` |
| `createAndConnect(input?, { pooled? })` | **[W]** `{ project, connectionString }` | one call + readiness; `pooled` default `true` |
| `update(id, input)` | `Project` | `input`: `{ name?, settings? }` |
| `delete(id)` | `Project` | |
| `transfer({ fromOrgId?, toOrgId, projectIds })` | **→void** | `fromOrgId` defaults to client `orgId` |
| `transferFromUser({ toOrgId, projectIds })` | **→void** | personal account → org |

```ts
// Provision a project and get a pooled connection string in one call
const { data } = await neon.projects.createAndConnect(
  { name: "tenant-42", region_id: "aws-us-east-1" },
  { pooled: true },
);
// data: { project, connectionString }

// Upgrade path: move projects from the sponsored org to the paid org
await neon.projects.transfer({
  fromOrgId: sponsoredOrgId,   // defaults to the client's `orgId`
  toOrgId: paidOrgId,
  projectIds: ["late-frost-12345"],
});
```

### `neon.branches`

| Method | Returns | Notes |
| --- | --- | --- |
| `list(projectId, query?)` | **[P]** `Branch` | `query`: `{ search?, sort_by?, sort_order?, include_deleted? }` |
| `get(projectId, branchId)` | `Branch` | |
| `create(projectId, input?)` | `Branch` | RW compute on by default. `noCompute: true` skips the endpoint. No connection string. Readiness polling on by default. `input`: `{ name?, parent_id?, parent_lsn?, parent_timestamp?, protected?, compute?: { minCu?, maxCu?, suspendTimeoutSeconds? }, noCompute? }` |
| `update(projectId, branchId, input)` | `Branch` | `input`: `{ name?, protected?, expires_at? }` |
| `delete(projectId, branchId)` | **→void** | |
| `createAndConnect(projectId, input?, { pooled? })` | **[W]** `{ branch, endpoint, connectionString }` | `input`: `{ name?, parentId?, compute?: { minCu?, maxCu?, suspendTimeoutSeconds? } }` |
| `getDefault(projectId)` | `Branch` | resolves the default branch by the `default` flag |
| `setDefault(projectId, branchId)` | `Branch` | |
| `resetFromParent(projectId, branchId, { preserveUnderName? }?)` | `Branch` | parent HEAD only; discards writes since the branch diverged. `preserveUnderName` is required when the branch has children. Pass `{ waitForReadiness: true }` before using the branch |
| `compareSchema(projectId, branchId, input)` | `{ diff? }` | `input`: `{ databaseName, baseBranchId?, lsn?, timestamp?, baseLsn?, baseTimestamp? }`. Omitting `baseBranchId` compares against the parent |
| `finalizeRestore(projectId, branchId, { name? }?)` | **→void** | commits a restore previewed with `snapshots.restore({ finalize: false })` |

**There is no `recover`.** Neon stopped publishing `POST /projects/{project_id}/branches/{branch_id}/recover` in its OpenAPI spec, so the wrapper is gone until it returns. The endpoint still answers, so a soft-deleted branch can still be recovered through the low-level client — note that this envelope carries the API's own error body rather than a `NeonError`:

```ts
import type { BranchRecoverResponse } from "@neon/sdk";

const { data } = await neon.client.post<{ 200: BranchRecoverResponse }>({
  url: "/projects/{project_id}/branches/{branch_id}/recover",
  path: { project_id: projectId, branch_id: branchId },
});
const branch = data?.branch;
```

`neon.projects.recover` is a different endpoint — it recovers a deleted **project**, not a branch.

```ts
// Resolve the project's default ("production") branch
const { data: prod } = await neon.branches.getDefault(projectId);

await neon.branches.create(projectId, {
  name: "preview/pr-123",
  parent_id: prod?.id,
});

await neon.branches.create(projectId, {
  name: "schema-only",
  parent_id: prod?.id,
  noCompute: true,
});

// Branch off it with its own compute — returns a ready connection string
const { data } = await neon.branches.createAndConnect(projectId, {
  name: "preview/pr-123",
  parentId: prod?.id,
  compute: { minCu: 0.25, maxCu: 2 },
});
// data: { branch, endpoint, connectionString }

const { data: schema } = await neon.branches.compareSchema(
  projectId,
  data!.branch.id,
  { databaseName: "neondb" },
);

await neon.branches.resetFromParent(projectId, data!.branch.id, undefined, {
  waitForReadiness: true,
});
```

### `neon.postgres`

The Postgres data plane of a branch. `neon.postgres.connectionString(params, options?)` resolves a URI, **auto-selecting** the default branch and the sole role/database when omitted:

```ts
const { data: uri } = await neon.postgres.connectionString({
  projectId,
  branchId?, endpointId?, databaseName?, roleName?, pooled?,  // all optional; pooled default true
});
```

#### `neon.postgres.endpoints`

| Method | Returns |
| --- | --- |
| `list(projectId)` | `Endpoint[]` |
| `get(projectId, endpointId)` | `Endpoint` |
| `create(projectId, input)` | `Endpoint` — `input`: `{ branch_id, type, autoscaling_limit_min_cu?, autoscaling_limit_max_cu?, suspend_timeout_seconds?, provisioner? }` |
| `update(projectId, endpointId, input)` | `Endpoint` |
| `delete(projectId, endpointId)` | **→void** |
| `start` / `suspend` / `restart(projectId, endpointId)` | `Endpoint` |

#### `neon.postgres.roles`

| Method | Returns |
| --- | --- |
| `list(projectId, branchId)` | `Role[]` |
| `get(projectId, branchId, name)` | `Role` |
| `create(projectId, branchId, { name, no_login? })` | `Role` |
| `delete(projectId, branchId, name)` | **→void** |
| `password(projectId, branchId, name)` | `string` (reveals the password) |
| `resetPassword(projectId, branchId, name)` | `Role` (carries the new password) |

```ts
// Reveal a role's password, or rotate it
const { data: password } = await neon.postgres.roles.password(projectId, branchId, "neondb_owner");
const { data: role } = await neon.postgres.roles.resetPassword(projectId, branchId, "neondb_owner");
// role.password holds the new secret
```

#### `neon.postgres.databases`

| Method | Returns |
| --- | --- |
| `list(projectId, branchId)` | `Database[]` |
| `get(projectId, branchId, name)` | `Database` |
| `create(projectId, branchId, { name, owner_name })` | `Database` |
| `update(projectId, branchId, name, { name?, owner_name? })` | `Database` |
| `delete(projectId, branchId, name)` | **→void** |

#### `neon.postgres.dataApi`

| Method | Returns |
| --- | --- |
| `get(projectId, branchId, databaseName)` | `DataApiReponse` |
| `create(projectId, branchId, databaseName, input?)` | `DataApiCreateResponse` |
| `update(projectId, branchId, databaseName, input?)` | **→void** |
| `delete(projectId, branchId, databaseName)` | **→void** |

### `neon.storage`

Branch-scoped object storage (beta). `neon.storage.get` returns whether storage is
enabled and the branch S3 endpoint metadata; buckets and objects are nested underneath.

#### `neon.storage` (branch state)

| Method | Returns |
| --- | --- |
| `get(projectId, branchId)` | `BranchStorage` |

#### `neon.storage.buckets`

| Method | Returns |
| --- | --- |
| `list(projectId, branchId)` | `Bucket[]` |
| `create(projectId, branchId, { name, access_level? })` | `Bucket` — `access_level`: `"private"` \| `"public_read"` |
| `delete(projectId, branchId, bucketName)` | **→void** |

#### `neon.storage.objects`

| Method | Returns | Notes |
| --- | --- | --- |
| `list(projectId, branchId, bucketName, query?)` | `BucketObjectsListResponse` | `query`: `{ prefix?, delimiter?, cursor?, limit? }` — one page (`folders`, `objects`, `next_cursor`) |
| `get(projectId, branchId, bucketName, objectKey)` | `Blob` | raw object bytes |
| `delete(projectId, branchId, bucketName, objectKey)` | **→void** | |
| `deleteByPrefix(projectId, branchId, bucketName, prefix)` | `{ deleted: number }` | `prefix` must end with `/` |
| `presign(projectId, branchId, bucketName, objectKey, input)` | `PresignResponse` | `input`: `{ operation: "upload" \| "download", content_type?, expires_in_seconds? }` |

```ts
// Upload via presigned PUT (same flow as neon bucket object put)
const { data: presign } = await neon.storage.objects.presign(
  projectId, branchId, "avatars", "user-1.png",
  { operation: "upload", content_type: "image/png" },
);
if (!presign) throw new Error("presign failed");

await fetch(presign.url, {
  method: "PUT",
  headers: { ...presign.headers, "Content-Length": String(bytes.length) },
  body: bytes,
});
```

### `neon.functions`

Branch-scoped Neon Functions (beta).

| Method | Returns | Notes |
| --- | --- | --- |
| `list(projectId, branchId, query?)` | **[P]** `NeonFunction` | `query`: `{ limit? }` |
| `get(projectId, branchId, slug)` | `NeonFunction` | |
| `update(projectId, branchId, slug, input)` | `NeonFunction` | `input`: `{ name? }` |
| `delete(projectId, branchId, slug)` | **→void** | |
| `deploy(projectId, branchId, slug, input?)` | `NeonFunctionDeployment` | multipart — `input`: `{ zip?: Blob \| File, runtime?: "nodejs24", environment?: string }` (`environment` is a JSON-encoded `Record<string, string>`) |

```ts
// Deploy a bundled index.mjs inside a zip (first deploy must include zip)
const zip = await Bun.file("bundle.zip").arrayBuffer();
const { data: deployment } = await neon.functions.deploy(projectId, branchId, "api", {
  zip: new File([zip], "bundle.zip", { type: "application/zip" }),
  runtime: "nodejs24",
});
// Poll neon.functions.get until current_deployment.status is "completed"
```

#### `neon.functions.customDomains`

Branch custom domains (beta). v1 can only point a domain at a function
(`entity_type: "function"`, `entity_id` is the function slug). The response
`cname_target` is the hostname to CNAME; the domain goes live after DNS
resolves and a certificate is issued on the first request.

| Method | Returns | Notes |
| --- | --- | --- |
| `list(projectId, branchId, query?)` | **[P]** `CustomDomain` | `query`: `{ limit? }` |
| `register(projectId, branchId, input)` | `CustomDomain` | `input`: `{ domain, entity_type, entity_id }` |
| `delete(projectId, branchId, domain)` | **→void** | |

```ts
const { data: registered } = await neon.functions.customDomains.register(
  projectId,
  branchId,
  { domain: "docs.example.com", entity_type: "function", entity_id: "api" },
);
// Point a CNAME for docs.example.com at registered.cname_target
```

### `neon.credentials`

Branch-scoped scoped credentials (beta). Secrets (`api_token`, `s3_secret_access_key`)
are returned **once** on `create`.

| Method | Returns | Notes |
| --- | --- | --- |
| `list(projectId, branchId)` | `CredentialMeta[]` | |
| `create(projectId, branchId, input)` | `CreateCredentialResponse` | `input`: `{ name?, scopes, principal_type: "user" }` — scopes: `storage:read`, `storage:write`, `ai_gateway:invoke`, `functions:invoke` |
| `revoke(projectId, branchId, tokenId)` | **→void** | |

### `neon.aiGateway`

Branch-scoped AI Gateway endpoint metadata (beta).

| Method | Returns | Notes |
| --- | --- | --- |
| `get(projectId, branchId)` | `BranchAiGateway` | 404 when AI Gateway is not enabled on the branch |

### `neon.logs`

Branch-scoped logs from the services running on a branch — Neon Functions, object
storage, and Postgres computes (private beta).

Being private beta shows, and all three calls behave the same way on a given branch:

| Branch state | Response |
| --- | --- |
| Telemetry not available in the branch's region | `404`, `reason: "telemetry_not_enabled"` |
| Project or branch missing, or no access to it | `404`, `reason: "branch_not_found"` |
| Telemetry available, nothing recorded in the window | `200` with an empty `logs` / `values` array |
| Telemetry available, backend down | `503`, which the client retries on by default |

**The two 404s need different handling, and only `reason` tells them apart.** Telemetry is
region-gated and the region is fixed at project creation, so `telemetry_not_enabled` is a
permanent property of the branch and an ordinary outcome to design around.
`branch_not_found` is a real error — a wrong id or a key without access — and should not
be absorbed into the same path. Both arrive as `NeonNotFoundError`, and `reason` is not
lifted onto the error, so it has to be read off the API's body, which the SDK keeps as
`unknown`:

```ts
import { NeonNotFoundError } from "@neon/sdk";

function logsUnavailableReason(error: unknown): string | undefined {
  if (!(error instanceof NeonNotFoundError)) return undefined;
  const body = error.body;
  if (typeof body !== "object" || body === null || !("reason" in body)) return undefined;
  return typeof body.reason === "string" ? body.reason : undefined;
}

const { error } = await neon.logs.fields(projectId, branchId);
if (error) {
  if (logsUnavailableReason(error) === "telemetry_not_enabled") {
    // no logs on this branch, ever — carry on
  } else throw error;
}
```

Two more limits worth knowing, because the spec is wider than the backend. `source` is a
three-value enum, but only `function` and `storage` were observed emitting; no branch
produced a `pg_endpoint` record. And `minimum_severity` can be rejected outright with a
`400` (`NeonApiError`, `kind: "api"`) reading
`"minimum_severity is not supported by this branch's log backend"` — so filter on
`severity_text` if you need it to work everywhere.

| Method | Returns | Notes |
| --- | --- | --- |
| `query(projectId, branchId, input?)` | **[P]** `ProjectBranchLogRecord` | `input`: `{ since?, start_time?, end_time?, limit?, sort_order?, source?, service_name?, scope_name?, minimum_severity?, severity_text?, body_contains?, trace_id?, logql? }` — filters combine with `AND` |
| `fields(projectId, branchId)` | `string[]` | field names this branch has emitted, usable as `fieldName` below |
| `fieldValues(projectId, branchId, fieldName, query?)` | `ProjectBranchLogFieldValuesResponse` | `query`: `{ since?, start_time?, end_time?, source?, limit? }` — check `is_truncated` |

Give the window as **either** `since` (`"30m"`, `"6h"`, `"7d"`) **or** `start_time`;
supplying both is rejected with `conflicting_time_range`. `logql` replaces the seven
content filters rather than adding to them — combining them is rejected with
`conflicting_filters` — while `limit`, `sort_order`, and the time window still apply
alongside it. Seven days is the widest range served. **The default window differs
between the two calls:** `query` covers the last hour, `fieldValues` the last six, so a
value discovered by one is not guaranteed to appear in the other.

`query` pages for you, replaying the filters unchanged as the endpoint requires. If a
page reports more records than it returned but no cursor to reach them, the walk fails
with a `client`-kind `NeonError` rather than handing back a partial result as if it
were complete.

```ts
// Errors from a function over the last 6 hours, newest first
const { data: errors } = await neon.logs
  .query(projectId, branchId, {
    since: "6h",
    source: "function",
    // some branches' log backends reject minimum_severity; severity_text always works
    minimum_severity: "error",
  })
  .all();

// Paging replays the filters for you — the endpoint returns wrong results otherwise
for await (const line of neon.logs.query(projectId, branchId, { since: "1h" })) {
  console.log(line.timestamp, line.message);
}

// Discover what you can enumerate, then read one field's values
const { data: fields } = await neon.logs.fields(projectId, branchId);
// e.g. ["service_name", "severity_text", "scope_name", "entity_type"]

const { data: services } = await neon.logs.fieldValues(
  projectId, branchId, "service_name", { since: "24h" },
);
console.log(services?.values);
if (services?.is_truncated) {
  // an arbitrary subset — narrow `since` or `source` before filtering on it
}
```

**`fieldName` must be a name `fields` returned.** The enumerable set and the filterable
set overlap rather than nest: `source` is a filter — on `query` and on `fieldValues`' own
query — but is not enumerable, so `fieldValues(…, "source")` answers `400` with
`reason: "unknown_field"`; `entity_type` is enumerable but is not a filter on `query`.

`fields` returns a bare `string[]` because its response carries nothing else.
`fieldValues` returns the whole response, because `is_truncated` is what decides whether
the values can be trusted and unwrapping would hide it.

### `neon.snapshots`

| Method | Returns | Notes |
| --- | --- | --- |
| `list(projectId)` | `Snapshot[]` | |
| `create(projectId, branchId, input?)` | `Snapshot` | `input`: `{ name?, timestamp?, lsn?, expiresAt? }` (point-in-time) |
| `update(projectId, snapshotId, input)` | `Snapshot` | `input`: `{ name?, expiresAt? }` — pass `expiresAt: null` to clear the expiration |
| `delete(projectId, snapshotId)` | **→void** | |
| `restore(projectId, snapshotId, input?)` | `Branch` | see below |
| `getSchedule(projectId, branchId)` | `BackupSchedule` | `frequency` stays a wide `string`: a branch can still hold a schedule created when the API accepted other values |
| `setSchedule(projectId, branchId, schedule)` | **→void** | `schedule.schedule[].frequency` is narrowed to `SnapshotFrequency` (`"daily" \| "weekly" \| "monthly"`) |

```ts
// Snapshot a branch at a point in time (or an `lsn`), with a name + TTL
const { data: snapshot } = await neon.snapshots.create(projectId, branchId, {
  name: "pre-migration",
  timestamp: "2026-06-01T00:00:00Z",
  expiresAt: "2026-07-01T00:00:00Z",
});
```

`restore` input: `{ name?, targetBranchId?, finalize?, preview?, keepOnAbort? }`.
- Restoring **as a new branch** (no `targetBranchId`) finalizes by default → ready to use.
- Restoring **onto an existing branch** doesn't finalize by default, so you can preview first.
- **Transaction-style** with `preview`: it restores un-finalized, runs your callback against the restored branch, then **finalizes (commit)** if it returns `true` or **deletes the preview branch (abort)** if `false` (unless `keepOnAbort`):

```ts
await neon.snapshots.restore(projectId, snapshotId, {
  targetBranchId,
  // second argument carries the call's signal; the SDK cannot interrupt your callback
  preview: async (branch, { signal }) =>
    (await checks(branch, { signal })) === "ok", // true → commit · false → abort
});
```

### `neon.operations`

| Method | Returns | Notes |
| --- | --- | --- |
| `list(projectId)` | **[P]** `Operation` | |
| `get(projectId, operationId)` | `Operation` | |
| `waitFor(operations, options?)` | **→void** | `options`: `{ pollIntervalMs?, timeoutMs?, signal? }` — the readiness primitive |

```ts
// Wait on operations from a raw call (or when waitForReadiness is off)
const { data } = await raw.createProjectBranch({
  client: neon.client,
  path: { project_id: projectId },
  body: { branch: { name: "wip" } },
});
const { error } = await neon.operations.waitFor(data!.operations, { timeoutMs: 120_000 });
```

### `neon.consumption`

Cursor-paginated billing metrics. Each takes `{ from, to, granularity, project_ids?, org_id? }` (`perBranchV2` requires `project_ids`).

| Method | Returns |
| --- | --- |
| `perProject(query)` | **[P]** `ConsumptionHistoryPerProject` |
| `perProjectV2(query)` | **[P]** `ConsumptionHistoryPerProjectV2` |
| `perBranchV2(query)` | **[P]** `ConsumptionHistoryPerBranchV2` |

```ts
// Paginated consumption metrics — stream every project across the range
for await (const project of neon.consumption.perProject({
  from: "2026-06-01T00:00:00Z",
  to: "2026-06-30T00:00:00Z",
  granularity: "daily",
  org_id: "org-...", // the org to report on; consumption requires a Scale plan or above
})) {
  console.log(project);
}
```

### `neon.apiKeys`

| Method | Returns | Notes |
| --- | --- | --- |
| `list()` | `ApiKeysListResponseItem[]` | |
| `create(keyName)` | `ApiKeyCreateResponse` | the `key` token is shown **once** |
| `revoke(keyId)` | `ApiKeyRevokeResponse` | |

### `neon.regions` / `neon.user`

| Method | Returns |
| --- | --- |
| `regions.list()` | `RegionResponse[]` |
| `user.me()` | `CurrentUserInfoResponse` |
| `user.organizations()` | `Organization[]` |

### `neon.auth`

Branch-scoped Neon Auth (the legacy project-scoped endpoints are deprecated and stay raw-only).

| Method | Returns | Notes |
| --- | --- | --- |
| `get(projectId, branchId)` | `NeonAuthIntegration` | |
| `create(projectId, branchId, input)` | `NeonAuthCreateIntegrationResponse` | enable the integration |
| `disable(projectId, branchId, { deleteData? }?)` | **→void** | |
| `updateConfig(projectId, branchId, input)` | `NeonAuthConfigResponse` | |
| `oauthProviders.list / add / update / delete` | `NeonAuthOauthProvider`(`[]`) / **→void** | |
| `trustedDomains.list / add / delete` | `NeonAuthRedirectUriWhitelistDomain[]` / **→void** | redirect-URI whitelist |
| `users.create / delete / updateRole` | `NeonAuthCreateNewUserResponse` / **→void** / role | |

### `neon.projects.permissions`

| Method | Returns |
| --- | --- |
| `list(projectId)` | `ProjectPermission[]` |
| `grant(projectId, email)` | `ProjectPermission` |
| `revoke(projectId, permissionId)` | `ProjectPermission` |

For an **org-owned** project, roles for existing organization members live on
`neon.projects.members` below instead.

### `neon.projects.members`

Per-project roles for members of the **owning organization**. Distinct from
`neon.projects.permissions`, which shares a project with an individual by email: these
act on existing org members by member id, and clearing a grant leaves the member's
organization-role default in force rather than removing their access. Org-owned projects
only — a personal project answers 404.

| Method | Returns | Notes |
| --- | --- | --- |
| `list(projectId, query?)` | **[P]** `ProjectMember` | `query`: `{ limit? }` |
| `setRole(projectId, memberId, role, { confirmSelfDemotion? }?)` | `ProjectMemberRoleResponse` | `role`: `"viewer" \| "editor" \| "admin"`; idempotent |
| `removeRole(projectId, memberId, { confirmSelfLockout? }?)` | `ProjectMemberRoleResponse` | clears the explicit grant; idempotent |

A `ProjectMember` carries several role-ish fields, and they are not interchangeable.
**Read `effective_project_permission`** for "what can this member actually do" — `VIEWER`
/ `EDITOR` / `ADMIN`, uppercase. `org_default_project_permission` and
`explicit_project_permission` are the two inputs it was resolved from, and `grant_source`
says which one won (`explicit`, `org_role_default`, `org_admin_override`, `unassigned`).

The two lowercase fields are a different axis: `project_role` is the explicit grant you
set with `setRole` and shares its `"viewer" | "editor" | "admin"` type, and `org_role` is
the member's organization role. Reading back `project_role` after a `setRole` tells you
the grant landed — it does **not** tell you the member's effective access, which the
org-role default can still exceed.

The two confirmations are **off by default** so a call cannot silently cost you access to
your own project. Pass one only when you mean to lower your own role
(`confirmSelfDemotion`) or to drop your own grant when that removes your management
access (`confirmSelfLockout`); without it the API rejects the call.

```ts
const { data: grant } = await neon.projects.members.setRole(
  projectId, memberId, "editor",
);
// A downgrade can leave credentials the member still holds
if (grant?.credential_rotation_recommended) { /* rotate database credentials */ }
if (grant?.org_api_key_rotation_recommended) { /* rotate project-scoped org keys */ }
```

Also on `neon.projects`: `recover(id)` (beta — recover a soft-deleted project), and on
`neon.postgres.endpoints`: `listByBranch(projectId, branchId)` → `Endpoint[]`.

---

## Raw layer (every endpoint, 1:1)

Anything not wrapped above is available raw. Pass `neon.client` to reuse the client's auth:

```ts
import { raw } from "@neon/sdk";
// or, for guaranteed tree-shaking: import { getProjectBranchSchema } from "@neon/sdk/raw";

const { data, error } = await raw.getProjectBranchSchema({
  client: neon.client,
  path: { project_id, branch_id },
  query: { db_name: "neondb" }, // db_name is required
});
```

**The raw layer speaks the exact same result contract as the ergonomic client.** By default a
raw call resolves to a `{ data, error }` `NeonResult` with the typed `NeonError` on the error
channel; pass `throwOnError: true` to get the bare resource and throw instead — and the
return type narrows accordingly:

```ts
// bare resource, throws the typed NeonError on failure
const { project } = await raw.getProject({
  client: neon.client,
  path: { project_id },
  throwOnError: true,
});
```

There is no `responseStyle` switch — `throwOnError` is the only one. `neon.client` is the
underlying configured Fetch client; `raw.*` are the wrapped generated functions, and all
request/response/error **types** are re-exported flat from `@neon/sdk` for
`import type { Project, Branch, … }`.

## Regenerating the client

The client is generated from a vendored, pinned copy of the spec in [`spec/neon-openapi.json`](./spec/neon-openapi.json) using [`@hey-api/openapi-ts`](https://heyapi.dev).

```bash
pnpm --filter @neon/sdk spec:pull   # refresh the vendored spec from neon.com
pnpm --filter @neon/sdk generate     # regenerate src/client
pnpm --filter @neon/sdk build        # typecheck + bundle
```

A coverage test (`src/neon/coverage.test.ts`) fails CI whenever the generated operation set changes, so every new endpoint is consciously wrapped or left raw-only. When you wrap new endpoints, also update this README (see `AGENTS.md` → **The SDK package**).

## License

Apache-2.0
