# Upcoming Realtime schemas

`realtime-protocol-v3.schema.json` describes protocol v3 of the Realtime
WebSocket protocol. In v3 the server can refresh part of a live result instead
of replacing all of it. A tick's `segments_pending` body says that some of its
rows arrive later. They arrive in a baseline whose `scope` is `selected`, which
names the segments it replaces.

This SDK doesn't use v3 yet. It speaks protocol v2, from the active
`../schema/realtime-protocol.schema.json`:

- no generator, test or runtime code reads this directory;
- it isn't part of the published package, because the package's `files` lists
  `schema/` and not `schema-next/`.

The Realtime proxy pins this file by commit and digest, so don't change its
bytes. The SDK change that adopts protocol v3 will:

1. move the active v2 schema to `../schema/legacy/`;
2. make this file the active `realtime-protocol.schema.json`, with its bytes
   unchanged;
3. regenerate the protocol types and validator;
4. remove this directory.
