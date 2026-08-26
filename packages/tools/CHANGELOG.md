# @neon/tools

## 0.8.0

### Minor Changes

- 9b322e7: Add `branches.resetFromParent` and `branches.compareSchema` to the SDK and as tools (`reset_from_parent_branches`, `compare_schema_branches`).

### Patch Changes

- Updated dependencies [9b322e7]
  - @neon/sdk@2.3.0

## 0.7.0

### Minor Changes

- 8a86bb3: Published tool ids are now the last SDK-path segment, then the resource, in snake_case (`projects.list` → `list_projects`, `postgres.connectionString` → `connection_string_postgres`). Hosts that need a historical name still pass `names`. A `descriptions` map keyed by the old published id no longer matches.

## 0.6.0

### Minor Changes

- c41fae7: `createNeonTools` now selects `@neon/sdk` methods by path (`tools: ["projects.list"]`). Operation-backed writes wait for readiness. `operations` and `workflows` selectors are removed.

## 0.5.0

### Minor Changes

- 93b93dc: `sendNeonAuthEmailProviderTest` is now on the generated raw client and in `@neon/tools`. It tests a branch's saved email provider without re-supplying the SMTP password. `sendNeonAuthTestEmail` is deprecated but still available for unsaved full SMTP configs.

### Patch Changes

- Updated dependencies [93b93dc]
  - @neon/sdk@2.2.0

## 0.4.0

### Minor Changes

- 6a31d50: `createNeonTools` accepts a `workflows` array that exposes `@neon/sdk` methods as `createBranchWithCompute` and `createProjectAndConnect`. Those tools attach compute, wait for readiness, and return a connection string. `CreateNeonToolsOptions` is a type alias, so an `interface` cannot extend it; `createNeonTools`'s first type argument is the options object.

## 0.3.0

### Minor Changes

- 7cf9afd: Generated tools take flat arguments instead of an OpenAPI path/query/body envelope. `create_project` takes `{ name, region_id, org_id, ... }`. `name` and `names` rename the published tool id.

## 0.2.0

### Minor Changes

- 5c57d00: Email-server GET responses now use `StandardEmailServerResponse` / `NeonAuthEmailServerConfigResponse`. `StandardEmailServer` is the write shape and its fields are optional, so a Better Auth project can send a partial update. A Stack Auth project still needs all six fields or the API returns 400. Code that read `host` (or the other five fields) off `StandardEmailServer` should switch the annotation to `StandardEmailServerResponse`.

### Patch Changes

- Updated dependencies [5c57d00]
  - @neon/sdk@2.1.0

## 0.1.0

### Minor Changes

- 2bb6dcf: Add generated, type-safe agent tools for every Neon Management API operation, with adapters for MCP, Eve, and Mastra. Tools authenticate with a Bearer credential: a Neon API key or a Neon OAuth access token.
- 2bb6dcf: Add optional description overrides, an execute hook for host tracking, and project/branch path injection on generated tools.
