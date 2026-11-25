---
"@neon/realtime": patch
---

Speak Realtime protocol v3, in which the server can refresh part of a live result instead of replacing all of it. There is no API change. While a refresh is pending, a query keeps showing its last complete result with status `live`; changes committed meanwhile, and their `awaitTxId()` confirmations, land together with it. Raw subscriptions receive a refresh as an ordinary atomic `changes` update: an unordered refresh removes every row it replaces before upserting, and an ordered one places its rows with moves.

The client now offers only `neon.realtime.v3`, so it needs an endpoint that serves protocol v3. A custom WebSocket server used in tests must update: accept `neon.realtime.v3`, and send `scope: { "kind": "all" }` on every full `baseline_sync_start`.

The unversioned `@neon/realtime/schema/realtime-protocol.schema.json` export now describes protocol v3, and a new `realtime-protocol-v3.schema.json` export aliases it. The versioned `realtime-protocol-v2.schema.json` export keeps its exact bytes, now from a frozen copy under `schema/legacy/`.
