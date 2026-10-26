---
"@neon/realtime": patch
---

Decode Realtime rows with large bytea values. Values above about 3 MiB were rejected with a protocol error, because the base64 check ran as a regular expression that overflowed V8's call stack. The check now runs in linear time and accepts exactly the same canonical base64 as before, so rows up to the 4 MiB server limit decode.
