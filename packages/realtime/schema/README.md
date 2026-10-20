# Realtime schemas

These files are the canonical public contracts for Realtime protocol messages
and decoded query capabilities. Their package exports use the same filenames:

- `@neon/realtime/schema/realtime-protocol-v2.schema.json` (active protocol)
- `@neon/realtime/schema/realtime-protocol-v1.schema.json` (unchanged compatibility contract)
- `@neon/realtime/schema/realtime-query-capability-v1.schema.json`

After editing a schema, run `pnpm --filter @neon/realtime generate` to refresh
the generated TypeScript types and standalone protocol validator. Build and
test scripts check that the generated files match the source schemas.

## Proxy synchronization

The Realtime proxy vendors these schemas from immutable commits in this
repository. Pin its protocol generator to:

- `packages/realtime/schema/realtime-protocol-v2.schema.json`
- `packages/realtime/schema/realtime-query-capability-v1.schema.json`

The SDK generates its active TypeScript types and standalone validator from v2.
V2 keeps the v1 envelopes and adds `move` with required `row_key` and
`after_row_key`; the latter is a row key or null for head. Validate normalized
program structure after joining fragments, then validate row/anchor existence
against the private candidate result. The v1 schema and fixtures remain stable.

Update the adjacent `.source.json` metadata with the source commit, path,
blob, source SHA-256, and generated SHA-256. Regenerate and check both schemas
using the proxy's `make realtime-protocol-schema`,
`make realtime-protocol-schema-check`, `make realtime-query-capability-schema`,
and `make realtime-query-capability-schema-check` targets. The source `$id`,
title, and audience now already match the proxy's Realtime identity.

The naming cleanup preserves live-query API names such as `useLiveQuery` and
`SealedLiveQuery`, the `live` lifecycle state, and the `live_id` wire field.
The single-key secret uses the opaque prefix `nrt_live_1`. The fingerprint
domain remains `neon-live-query-fingerprint-v1\0`.
