# @neon/effect

## 0.4.0

### Minor Changes

- 3046aec: Add Neon incident reporting from neonstatus.com: `listNeonIncidents()` and `neon.incidents.list()` in `@neon/sdk` (also on the `@neon/effect` client), the `list_incidents` tool (`incidents.list`) in `@neon/tools`, and the `neon incidents` command. None of them need a Neon credential.

### Patch Changes

- Updated dependencies [3046aec]
  - @neon/sdk@7.12.0

## 0.3.2

### Patch Changes

- Updated dependencies [53516b8]
  - @neon/sdk@7.11.0

## 0.3.1

### Patch Changes

- Updated dependencies [a564258]
  - @neon/sdk@7.10.0

## 0.3.0

### Minor Changes

- 30e938a: Add `neon.organizations`: `get`, `members.list|get|update|remove`, `invitations.list|create`, `spendingLimit.get|set|delete`, and `apiKeys.list|create|revoke` for organization API keys. Every method takes `orgId` and defaults to the client's `orgId`. `@neon/tools` publishes them as `organizations.*` tools, with approval required for every write, and `@neon/effect` streams `organizations.members.list`.

### Patch Changes

- Updated dependencies [30e938a]
  - @neon/sdk@7.9.0

## 0.2.6

### Patch Changes

- Updated dependencies [9288206]
  - @neon/sdk@7.8.2

## 0.2.5

### Patch Changes

- Updated dependencies [891072b]
  - @neon/sdk@7.8.1

## 0.2.4

### Patch Changes

- Updated dependencies [f4b216f]
  - @neon/sdk@7.8.0

## 0.2.3

### Patch Changes

- Updated dependencies [9b8d302]
  - @neon/sdk@7.7.0

## 0.2.2

### Patch Changes

- Updated dependencies [207d650]
  - @neon/sdk@7.6.1

## 0.2.1

### Patch Changes

- Updated dependencies [d7b777c]
  - @neon/sdk@7.6.0

## 0.2.0

### Minor Changes

- c745d8e: Add `neon.projects.count()`, which returns the number of active projects in the organization without paging through `projects.list()` (`GET /projects/count`, beta). It takes `{ org_id? }` and defaults to the client's `orgId`. `@neon/tools` publishes it as the `projects.count` selector (`count_projects`), and `@neon/effect` exposes it as an `Effect<number>`.

### Patch Changes

- Updated dependencies [c745d8e]
- Updated dependencies [d23ace5]
  - @neon/sdk@7.5.0

## 0.1.5

### Patch Changes

- Updated dependencies [8b0e72b]
- Updated dependencies [cb6a151]
  - @neon/sdk@7.4.0

## 0.1.4

### Patch Changes

- Updated dependencies [0cee585]
  - @neon/sdk@7.3.0

## 0.1.3

### Patch Changes

- Updated dependencies [5f572b6]
  - @neon/sdk@7.2.0

## 0.1.2

### Patch Changes

- Updated dependencies [025988c]
  - @neon/sdk@7.1.0

## 0.1.1

### Patch Changes

- Updated dependencies [d1ddfe5]
  - @neon/sdk@7.0.1

## 0.1.0

### Minor Changes

- 4ffd4eb: New package: Effect v4 bindings for `@neon/sdk`. Every client method returns an `Effect`, paginated lists return a `Stream`, SDK errors are tagged for `Effect.catchTag`, and interrupting a fiber cancels the request. Provide the client with `layer(config)` or `layerConfig`, or create one with `make(config)`.
