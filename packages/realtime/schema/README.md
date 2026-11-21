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
contract tests; the legacy tests remove the v3 additions from them first.

Existing versioned package exports retain their original contracts:

- Protocol v1, protocol v2 and capability v1 versioned exports resolve to their
  frozen legacy snapshots.
- Protocol v3 and capability v2 versioned exports alias the active schemas.

Protocol v2 is still decoded at runtime, from the active v3 validator: a v2
frame carries none of the v3 additions, and its baseline sync is a v3 round
with scope `all` and no covered range. The codec test checks that this decoder
accepts exactly the frames the frozen v2 snapshot accepts.

Keep the legacy export throughout 0.2. Remove its snapshot, export, package-test
entry and isolated legacy tests at the next compatibility-breaking release,
with a changeset announcing the removal. Before changing either active
contract's version, preserve or explicitly remove its old versioned export;
never let an old versioned export silently resolve to a newer contract.

## Proxy synchronization and rollout

The Realtime proxy vendors these schemas from immutable commits and source
paths. Existing pins remain valid at their original commits. Protocol v3 is
pinned from `packages/realtime/schema/realtime-protocol.schema.json` at the
commit that introduced it; protocol v2 remains pinned at its earlier commit.

Protocol v3 adds partial refreshes of a live result. A publication can commit
a hole (`segments_pending`): some of a target's rows for that tick arrive later,
in a round. A round is a baseline sync with a `round` ID and a `scope`; a
selected round replaces only the named segments of a live result and carries
the `covered` range of the holes it resolves. Rows and upserts of multi-row
segments carry an opaque `segment_tag`. Applications never see tags or
selectors.

This SDK offers `neon.realtime.v3` and `neon.realtime.v2` and decodes the one
the proxy selects; a proxy that predates v3 selects v2 and delivers full
replacement only. Protocol v1 and capability v1 remain available for
previously released clients. This SDK emits capability v2.

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
