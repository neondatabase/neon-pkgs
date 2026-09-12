# Migrating to named parameters

The next major release of `@neon/sdk` changes ergonomic resource methods that took
positional identifiers or other scalar values. Those values now belong in one flat,
named parameter object. `CallOptions` remains a separate final argument.

```ts
// Before
await neon.branches.update(projectId, branchId, { name: "preview" }, {
  throwOnError: true,
});

// Next major
await neon.branches.update(
  { projectId, branchId, name: "preview" },
  { throwOnError: true },
);
```

This is a direct breaking change: positional overloads are removed. Return values,
`{ data, error }` behavior, `throwOnError`, readiness polling, retries, cancellation,
and API requests keep their existing meanings.

## Migration rules

- Put resource locators and request or query fields together in the first object.
- Keep `CallOptions` second: `{ throwOnError?, waitForReadiness?, requestTimeoutMs?,
  wait?, signal? }`.
- Use `projectId` and `branchId` for project and branch identifiers.
- Use `databaseName` to locate an existing database. On `databases.update`, `name`
  remains the optional new name.
- Use `roleName` to locate an existing Postgres role. The `name` field on
  `roles.create` is unchanged.
- Keep existing payload spelling. OpenAPI payload and query fields such as `org_id`,
  `parent_id`, `expires_at`, `owner_name`, `content_type`, and `principal_type` stay
  snake_case.

`…input` and `…query` below mean the same fields accepted by the old input or query
object, now flattened into the named parameter object.

Common replacements:

```ts
// One identifier, then multiple identifiers
await neon.projects.get({ projectId });
await neon.branches.get({ projectId, branchId });

// Create and update payloads are flat
await neon.branches.create({ projectId, name: "preview", parent_id: branchId });
await neon.branches.update({ projectId, branchId, name: "renamed" });

// List filters share the first object with the locator
const branches = await neon.branches
  .list({ projectId, search: "preview", include_deleted: false })
  .all();

// A method with an optional old payload still receives the required locators
await neon.branches.resetFromParent({ projectId, branchId });

// Locate the database with databaseName; name remains the rename value
await neon.postgres.databases.update({
  projectId,
  branchId,
  databaseName: "app",
  name: "app_v2",
});

await neon.snapshots.setSchedule({
  projectId,
  branchId,
  schedule: [{ frequency: "daily", retention_seconds: 7 * 24 * 60 * 60 }],
});

await neon.operations.waitFor(
  { operations },
  { pollIntervalMs: 1_000, timeoutMs: 120_000 },
);
```

## Changed methods

### Projects, permissions, and members

| Method | Before | Next major |
| --- | --- | --- |
| `projects.get` | `get(id)` | `get({ projectId })` |
| `projects.createAndConnect` | `createAndConnect(input?, { pooled?, …options }?)` | `createAndConnect({ …input, pooled? }, options?)` |
| `projects.update` | `update(id, input)` | `update({ projectId, …input })` |
| `projects.delete` | `delete(id)` | `delete({ projectId })` |
| `projects.recover` | `recover(id)` | `recover({ projectId })` |
| `projects.permissions.list` | `list(projectId)` | `list({ projectId })` |
| `projects.permissions.grant` | `grant(projectId, email)` | `grant({ projectId, email })` |
| `projects.permissions.revoke` | `revoke(projectId, permissionId)` | `revoke({ projectId, permissionId })` |
| `projects.members.list` | `list(projectId, query?)` | `list({ projectId, …query })` |
| `projects.members.setRole` | `setRole(projectId, memberId, role, { confirmSelfDemotion?, …options }?)` | `setRole({ projectId, memberId, role, confirmSelfDemotion? }, options?)` |
| `projects.members.removeRole` | `removeRole(projectId, memberId, { confirmSelfLockout?, …options }?)` | `removeRole({ projectId, memberId, confirmSelfLockout? }, options?)` |

### Branches

| Method | Before | Next major |
| --- | --- | --- |
| `branches.list` | `list(projectId, query?)` | `list({ projectId, …query })` |
| `branches.get` | `get(projectId, branchId)` | `get({ projectId, branchId })` |
| `branches.create` | `create(projectId, input?)` | `create({ projectId, …input })` |
| `branches.update` | `update(projectId, branchId, input)` | `update({ projectId, branchId, …input })` |
| `branches.delete` | `delete(projectId, branchId)` | `delete({ projectId, branchId })` |
| `branches.createAndConnect` | `createAndConnect(projectId, input?, { pooled?, …options }?)` | `createAndConnect({ projectId, …input, pooled? }, options?)` |
| `branches.getDefault` | `getDefault(projectId)` | `getDefault({ projectId })` |
| `branches.setDefault` | `setDefault(projectId, branchId)` | `setDefault({ projectId, branchId })` |
| `branches.resetFromParent` | `resetFromParent(projectId, branchId, input?)` | `resetFromParent({ projectId, branchId, …input })` |
| `branches.compareSchema` | `compareSchema(projectId, branchId, input)` | `compareSchema({ projectId, branchId, …input })` |
| `branches.finalizeRestore` | `finalizeRestore(projectId, branchId, input?)` | `finalizeRestore({ projectId, branchId, …input })` |

### Postgres

| Method | Before | Next major |
| --- | --- | --- |
| `postgres.endpoints.list` | `list(projectId)` | `list({ projectId })` |
| `postgres.endpoints.listByBranch` | `listByBranch(projectId, branchId)` | `listByBranch({ projectId, branchId })` |
| `postgres.endpoints.get` | `get(projectId, endpointId)` | `get({ projectId, endpointId })` |
| `postgres.endpoints.create` | `create(projectId, input)` | `create({ projectId, …input })` |
| `postgres.endpoints.update` | `update(projectId, endpointId, input)` | `update({ projectId, endpointId, …input })` |
| `postgres.endpoints.delete` | `delete(projectId, endpointId)` | `delete({ projectId, endpointId })` |
| `postgres.endpoints.start` | `start(projectId, endpointId)` | `start({ projectId, endpointId })` |
| `postgres.endpoints.suspend` | `suspend(projectId, endpointId)` | `suspend({ projectId, endpointId })` |
| `postgres.endpoints.restart` | `restart(projectId, endpointId)` | `restart({ projectId, endpointId })` |
| `postgres.roles.list` | `list(projectId, branchId)` | `list({ projectId, branchId })` |
| `postgres.roles.get` | `get(projectId, branchId, name)` | `get({ projectId, branchId, roleName })` |
| `postgres.roles.create` | `create(projectId, branchId, input)` | `create({ projectId, branchId, …input })` |
| `postgres.roles.delete` | `delete(projectId, branchId, name)` | `delete({ projectId, branchId, roleName })` |
| `postgres.roles.password` | `password(projectId, branchId, name)` | `password({ projectId, branchId, roleName })` |
| `postgres.roles.resetPassword` | `resetPassword(projectId, branchId, name)` | `resetPassword({ projectId, branchId, roleName })` |
| `postgres.databases.list` | `list(projectId, branchId)` | `list({ projectId, branchId })` |
| `postgres.databases.get` | `get(projectId, branchId, name)` | `get({ projectId, branchId, databaseName })` |
| `postgres.databases.create` | `create(projectId, branchId, input)` | `create({ projectId, branchId, …input })` |
| `postgres.databases.update` | `update(projectId, branchId, name, input)` | `update({ projectId, branchId, databaseName, …input })` |
| `postgres.databases.delete` | `delete(projectId, branchId, name)` | `delete({ projectId, branchId, databaseName })` |
| `postgres.dataApi.get` | `get(projectId, branchId, databaseName)` | `get({ projectId, branchId, databaseName })` |
| `postgres.dataApi.create` | `create(projectId, branchId, databaseName, input?)` | `create({ projectId, branchId, databaseName, …input })` |
| `postgres.dataApi.update` | `update(projectId, branchId, databaseName, input?)` | `update({ projectId, branchId, databaseName, …input })` |
| `postgres.dataApi.delete` | `delete(projectId, branchId, databaseName)` | `delete({ projectId, branchId, databaseName })` |

### Storage and functions

| Method | Before | Next major |
| --- | --- | --- |
| `storage.get` | `get(projectId, branchId)` | `get({ projectId, branchId })` |
| `storage.buckets.list` | `list(projectId, branchId)` | `list({ projectId, branchId })` |
| `storage.buckets.create` | `create(projectId, branchId, input)` | `create({ projectId, branchId, …input })` |
| `storage.buckets.delete` | `delete(projectId, branchId, bucketName)` | `delete({ projectId, branchId, bucketName })` |
| `storage.objects.list` | `list(projectId, branchId, bucketName, query?)` | `list({ projectId, branchId, bucketName, …query })` |
| `storage.objects.get` | `get(projectId, branchId, bucketName, objectKey)` | `get({ projectId, branchId, bucketName, objectKey })` |
| `storage.objects.delete` | `delete(projectId, branchId, bucketName, objectKey)` | `delete({ projectId, branchId, bucketName, objectKey })` |
| `storage.objects.deleteByPrefix` | `deleteByPrefix(projectId, branchId, bucketName, prefix)` | `deleteByPrefix({ projectId, branchId, bucketName, prefix })` |
| `storage.objects.presign` | `presign(projectId, branchId, bucketName, objectKey, input)` | `presign({ projectId, branchId, bucketName, objectKey, …input })` |
| `functions.list` | `list(projectId, branchId, query?)` | `list({ projectId, branchId, …query })` |
| `functions.get` | `get(projectId, branchId, slug)` | `get({ projectId, branchId, slug })` |
| `functions.update` | `update(projectId, branchId, slug, input)` | `update({ projectId, branchId, slug, …input })` |
| `functions.delete` | `delete(projectId, branchId, slug)` | `delete({ projectId, branchId, slug })` |
| `functions.deploy` | `deploy(projectId, branchId, slug, input?)` | `deploy({ projectId, branchId, slug, …input })` |
| `functions.customDomains.list` | `list(projectId, branchId, query?)` | `list({ projectId, branchId, …query })` |
| `functions.customDomains.register` | `register(projectId, branchId, input)` | `register({ projectId, branchId, …input })` |
| `functions.customDomains.delete` | `delete(projectId, branchId, domain)` | `delete({ projectId, branchId, domain })` |

### Triggers, credentials, gateway, and logs

| Method | Before | Next major |
| --- | --- | --- |
| `triggers.list` | `list(projectId, branchId)` | `list({ projectId, branchId })` |
| `triggers.create` | `create(projectId, branchId, input)` | `create({ projectId, branchId, …input })` |
| `triggers.get` | `get(projectId, branchId, triggerId)` | `get({ projectId, branchId, triggerId })` |
| `triggers.update` | `update(projectId, branchId, triggerId, input)` | `update({ projectId, branchId, triggerId, …input })` |
| `triggers.delete` | `delete(projectId, branchId, triggerId)` | `delete({ projectId, branchId, triggerId })` |
| `credentials.list` | `list(projectId, branchId)` | `list({ projectId, branchId })` |
| `credentials.create` | `create(projectId, branchId, input)` | `create({ projectId, branchId, …input })` |
| `credentials.revoke` | `revoke(projectId, branchId, tokenId)` | `revoke({ projectId, branchId, tokenId })` |
| `credentials.reveal` | `reveal(projectId, branchId, tokenId)` | `reveal({ projectId, branchId, tokenId })` |
| `credentials.rotate` | `rotate(projectId, branchId, tokenId)` | `rotate({ projectId, branchId, tokenId })` |
| `aiGateway.get` | `get(projectId, branchId)` | `get({ projectId, branchId })` |
| `logs.query` | `query(projectId, branchId, input?)` | `query({ projectId, branchId, …input })` |
| `logs.fields` | `fields(projectId, branchId)` | `fields({ projectId, branchId })` |
| `logs.fieldValues` | `fieldValues(projectId, branchId, fieldName, query?)` | `fieldValues({ projectId, branchId, fieldName, …query })` |

### Snapshots and operations

| Method | Before | Next major |
| --- | --- | --- |
| `snapshots.list` | `list(projectId)` | `list({ projectId })` |
| `snapshots.create` | `create(projectId, branchId, input?)` | `create({ projectId, branchId, …input })` |
| `snapshots.update` | `update(projectId, snapshotId, input)` | `update({ projectId, snapshotId, …input })` |
| `snapshots.delete` | `delete(projectId, snapshotId)` | `delete({ projectId, snapshotId })` |
| `snapshots.restore` | `restore(projectId, snapshotId, input?)` | `restore({ projectId, snapshotId, …input })` |
| `snapshots.getSchedule` | `getSchedule(projectId, branchId)` | `getSchedule({ projectId, branchId })` |
| `snapshots.setSchedule` | `setSchedule(projectId, branchId, schedule)` | `setSchedule({ projectId, branchId, schedule })` |
| `operations.list` | `list(projectId)` | `list({ projectId })` |
| `operations.get` | `get(projectId, operationId)` | `get({ projectId, operationId })` |
| `operations.waitFor` | `waitFor(operations, options?)` | `waitFor({ operations }, options?)` |

`operations.waitFor` still accepts `pollIntervalMs`, `timeoutMs`, `signal`, and
`throwOnError` in its second argument. As before, its execution options exclude
`requestTimeoutMs`, `waitForReadiness`, and `wait` because the operation poller owns its
own timeout and interval.

### API keys and Neon Auth

| Method | Before | Next major |
| --- | --- | --- |
| `apiKeys.create` | `create(keyName)` | `create({ keyName })` |
| `apiKeys.revoke` | `revoke(keyId)` | `revoke({ keyId })` |
| `auth.get` | `get(projectId, branchId)` | `get({ projectId, branchId })` |
| `auth.create` | `create(projectId, branchId, input)` | `create({ projectId, branchId, …input })` |
| `auth.disable` | `disable(projectId, branchId, input?)` | `disable({ projectId, branchId, …input })` |
| `auth.updateConfig` | `updateConfig(projectId, branchId, input)` | `updateConfig({ projectId, branchId, …input })` |
| `auth.oauthProviders.list` | `list(projectId, branchId)` | `list({ projectId, branchId })` |
| `auth.oauthProviders.add` | `add(projectId, branchId, input)` | `add({ projectId, branchId, …input })` |
| `auth.oauthProviders.update` | `update(projectId, branchId, providerId, input)` | `update({ projectId, branchId, providerId, …input })` |
| `auth.oauthProviders.delete` | `delete(projectId, branchId, providerId)` | `delete({ projectId, branchId, providerId })` |
| `auth.trustedDomains.list` | `list(projectId, branchId)` | `list({ projectId, branchId })` |
| `auth.trustedDomains.add` | `add(projectId, branchId, input)` | `add({ projectId, branchId, …input })` |
| `auth.trustedDomains.delete` | `delete(projectId, branchId, input)` | `delete({ projectId, branchId, …input })` |
| `auth.users.create` | `create(projectId, branchId, input)` | `create({ projectId, branchId, …input })` |
| `auth.users.delete` | `delete(projectId, branchId, authUserId)` | `delete({ projectId, branchId, authUserId })` |
| `auth.users.updateRole` | `updateRole(projectId, branchId, authUserId, roles)` | `updateRole({ projectId, branchId, authUserId, roles })` |

## Fields that moved from options

Three workflow or safety fields are method input, not execution policy, so they move to
the first object:

```ts
await neon.projects.createAndConnect(
  { name: "app", pooled: false },
  { wait: { timeoutMs: 600_000 } },
);

await neon.branches.createAndConnect(
  { projectId, name: "preview", pooled: false },
  { signal },
);

await neon.projects.members.setRole(
  { projectId, memberId, role: "viewer", confirmSelfDemotion: true },
  { throwOnError: true },
);

await neon.projects.members.removeRole(
  { projectId, memberId, confirmSelfLockout: true },
  { throwOnError: true },
);
```

`SetRoleOptions` and `RemoveRoleOptions` remain exported as aliases of `CallOptions`.
They no longer contain the confirmation fields.

## Parameter types

Every changed method exports a resource-qualified `*Params` type next to its resource.
Examples include `ProjectGetParams`, `BranchUpdateParams`, `DatabasesUpdateParams`,
`BucketObjectsPresignParams`, `AuthUsersUpdateRoleParams`, and
`OperationsWaitForParams`:

```ts
import type { BranchCreateParams, CallOptions } from "@neon/sdk";

const params: BranchCreateParams = {
  projectId,
  name: "preview",
  parent_id: parentBranchId,
};
const options: CallOptions = { signal };

await neon.branches.create(params, options);
```

The types preserve the existing generated request fields and aliases. They do not rename
snake_case payload properties.

## Unchanged calls

Methods that were already object-only keep their call shape: `projects.list`,
`projects.create`, `projects.transfer`, `projects.transferFromUser`,
`postgres.connectionString`, and the three `consumption` methods. Zero-input methods
also stay unchanged: `apiKeys.list`, `regions.list`, `user.me`, and
`user.organizations`.

The raw API is unchanged. Raw methods still take the generated `{ client, path, query,
body, … }` object. Pagination is also unchanged after construction: `.page(cursor)`,
`.all()`, and async iteration keep the same signatures and return behavior. Callback
signatures are unchanged; for example, the `snapshots.restore` preview callback still
receives `(branch, { signal })`.

## JavaScript callers and invalid legacy input

TypeScript reports positional calls at compile time. JavaScript callers that pass a
legacy scalar where a named parameter object is required receive a typed
`NeonClientError` through the usual result or throw channel:

```js
import { createNeonClient, NeonClientError } from "@neon/sdk";

const neon = createNeonClient({ apiKey });
const result = await neon.projects.get("project-id");
result.error instanceof NeonClientError; // true
result.error.kind; // "client"

const throwing = createNeonClient({ apiKey, throwOnError: true });
await throwing.projects.get("project-id"); // throws NeonClientError
```

Paginated methods remain lazy, so validation surfaces when the pagination object is
consumed:

```js
const branches = neon.branches.list("project-id");

const page = await branches.page(); // { data: undefined, error: NeonClientError }
const all = await branches.all();   // { data: undefined, error: NeonClientError }

for await (const branch of branches) {
  // async iteration always throws on an error, including NeonClientError
}
```

For the fields that moved from options, JavaScript does not get a positional-object
validation error because both arguments are objects. Move `pooled`,
`confirmSelfDemotion`, and `confirmSelfLockout` into the first object so the requested
behavior is applied.
