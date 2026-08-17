# @neon/tools

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
