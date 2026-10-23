# Realtime schemas

The active public contracts have stable filenames. Keep future revisions in
these files so their changes remain easy to review:

| Contract | Canonical source and package export | Current identity |
| --- | --- | --- |
| WebSocket messages | `realtime-protocol.schema.json` | Protocol v2 |
| Decoded query capabilities | `realtime-query-capability.schema.json` | Capability v1 |

Import them through `@neon/realtime/schema/<filename>`. The version remains in
`$id` and `title`; `$schema` identifies the JSON Schema dialect. Protocol and
capability versions evolve independently. A source filename is not a wire
protocol identifier.

After editing an active schema, run `pnpm --filter @neon/realtime generate` to
refresh the generated TypeScript types and standalone protocol validator.
Build and test scripts check that the generated files match the active schemas.

## Legacy protocol and export compatibility

`legacy/realtime-protocol-v1.schema.json` is a frozen snapshot. No generator or
runtime code consumes it. Its only schema-validation consumer is the isolated
`src/client/protocol/schema/legacy/contract.test.ts`, which checks the exact
bytes pinned by the transition proxy and the old content-only contract.
The shared protocol fixtures belong to the active codec and contract tests.

Existing versioned package exports retain their original contracts:

- `@neon/realtime/schema/realtime-protocol-v2.schema.json` aliases the active
  protocol schema, currently v2.
- `@neon/realtime/schema/realtime-query-capability-v1.schema.json` aliases the
  active capability schema, currently v1.
- `@neon/realtime/schema/realtime-protocol-v1.schema.json` resolves to the frozen
  legacy snapshot. This export is deprecated; prefer the active schema or pin
  an older package/commit when the v1 contract is specifically required.

Keep the legacy export throughout 0.2. Remove its snapshot, export, package-test
entry and isolated legacy tests at the next compatibility-breaking release,
with a changeset announcing the removal. Before changing either active
contract's version, preserve or explicitly remove its old versioned export;
never let an old versioned export silently resolve to a newer contract.

## Proxy synchronization and rollout

The Realtime proxy vendors these schemas from immutable commits. Existing
Hadron #11138 pins remain valid at their original commits and source paths.
This file-layout change preserves all schema bytes, identities, generated SDK
code and WebSocket behavior; it requires no server deployment or repinning.

For a future pin to the stable source paths, use:

- `packages/realtime/schema/realtime-protocol.schema.json`
- `packages/realtime/schema/realtime-query-capability.schema.json`

That Hadron maintenance change must also let `sync-public-schema.py` accept the
new source paths and update the adjacent `.source.json` metadata (commit, path,
blob and digests). Keep the version-specific identity checks. Verify both
schemas with the proxy's `make realtime-protocol-schema-check` and
`make realtime-query-capability-schema-check` targets. Old commit pins need no
migration.

The transition server from Hadron #11138 accepts `neon.realtime.v1` and
`neon.realtime.v2` and delivers ordered results as complete replacements, so
existing v1 clients and the new v2 SDK can connect during rollout. This SDK
still requests v2 only. Enabling incremental ordered delivery and requiring
v2 belongs to the separate activation deployment after the client upgrade.

V2 keeps the existing envelopes and adds `move` with required `row_key` and
`after_row_key`; the latter is a row key or null for head. Validate normalized
program structure after joining fragments, then validate row/anchor existence
against the private candidate result.

The live-query API names such as `useLiveQuery` and `SealedLiveQuery`, the `live`
lifecycle state and `live_id` wire field are unchanged. The single-key secret
uses the opaque prefix `nrt_live_1`. The fingerprint domain remains
`neon-live-query-fingerprint-v1\0`.
