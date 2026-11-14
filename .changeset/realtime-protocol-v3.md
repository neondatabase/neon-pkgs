---
"@neon/realtime": patch
---

Support Realtime protocol v3, in which the server can refresh part of a live result instead of replacing it. The client offers `neon.realtime.v3` and `neon.realtime.v2` and decodes the one the server selects, so it keeps working with servers that only speak v2.

While a partial refresh is pending, a materialized snapshot has `updating: true` and keeps the last complete rows; changes committed meanwhile, and their `awaitTxId()` confirmations, land together with the refresh as one update. Raw subscriptions receive the refresh as one `changes` update that removes every replaced row before upserting the new ones, never as a `rows` replacement. `@neon/realtime-react` and `@neon/realtime-tanstack` need no changes.

The package exports the v3 schema as `@neon/realtime/schema/realtime-protocol-v3.schema.json` and as the active `realtime-protocol.schema.json`; `realtime-protocol-v2.schema.json` now resolves to a frozen v2 snapshot. A custom `webSocketFactory` must return a transport that reports the selected subprotocol through the standard `protocol` property, as browser, React Native and `ws` WebSockets do.
