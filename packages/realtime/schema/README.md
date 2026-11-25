# Realtime schemas

The active public contracts have stable filenames. Keep future revisions in
these files so their changes remain easy to review:

| Contract | Canonical source and package export | Current identity |
| --- | --- | --- |
| WebSocket messages | `realtime-protocol.schema.json` | Protocol v3 |
| Decoded query capabilities | `realtime-query-capability.schema.json` | Capability v2 |

Import them through `@neon/realtime/schema/<filename>`. The version remains in
`$id` and `title`; `$schema` identifies the JSON Schema dialect. Protocol and
capability versions evolve independently. A source filename is not a wire
protocol identifier.

After editing an active schema, run `pnpm --filter @neon/realtime generate` to
refresh the generated TypeScript types and standalone protocol validator.
Build and test scripts check that the generated files match the active schemas.

## Legacy contracts and export compatibility

The schemas under `legacy/` are frozen snapshots. No generator or runtime code
consumes them. The isolated legacy contract test checks their exact bytes and
their original contracts. Shared fixtures belong to the active codec and
contract tests.

Existing versioned package exports retain their original contracts:

- Protocol v1, protocol v2 and capability v1 versioned exports resolve to their
  frozen legacy snapshots. The protocol v2 snapshot keeps the exact bytes the
  v2 export resolved to before protocol v3 became active.
- Protocol v3 and capability v2 versioned exports alias the active schemas.

Keep the legacy export throughout 0.2. Remove its snapshot, export, package-test
entry and isolated legacy tests at the next compatibility-breaking release,
with a changeset announcing the removal. Before changing either active
contract's version, preserve or explicitly remove its old versioned export;
never let an old versioned export silently resolve to a newer contract.

## Proxy synchronization and rollout

The Realtime proxy vendors these schemas from immutable commits and pins them by
digest. Existing pins remain valid at their original commits and source paths.
Protocol v3 was first published as `schema-next/realtime-protocol-v3.schema.json`;
it is now the active `realtime-protocol.schema.json` with its bytes unchanged, so
both paths have the same digest. Protocol v2 keeps its bytes under `legacy/`.

This SDK requests only `neon.realtime.v3`, including on reconnect, and emits
capability v2. Deploy a proxy that serves protocol v3 before releasing it.
Protocol v1 and v2 remain available for previously released clients.

Protocol v3 adds partial refreshes. A publication can commit a hole
(`segments_pending`): some of a live query's rows for that tick arrive later, in
a round. A round is a baseline sync whose `scope` is `selected`: it replaces
only the named segments and resolves the holes in its `covered` range. Rows and
upserts of multi-row segments carry an opaque `segment_tag`, and rows of an
ordered round can carry `after_row_key`. Applications never see tags, scopes
or holes; the client turns each round into an ordinary `changes` update.

V2 added `move` with required `row_key` and
`after_row_key`; the latter is a row key or null for head. Validate normalized
program structure after joining fragments, then validate row/anchor existence
against the private candidate result.

The live-query API names such as `useLiveQuery` and `SealedLiveQuery`, the `live`
lifecycle state and `live_id` wire field are unchanged. The single-key secret
uses the opaque prefix `nrt_live_1`. The fingerprint domain remains
`neon-live-query-fingerprint-v1\0`.

Protocol v2 requires one bounded `client_info` message after `ready` and before
subscription commands. Capability v2 adds authenticated, bounded issuer
metadata. Query sources and downstream release-line buckets are closed;
unrecognized canonical release lines normalize to `unknown`, so metric
cardinality remains fixed.
