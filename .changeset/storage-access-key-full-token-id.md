---
"@neondatabase/env": patch
---

Fix object-storage credentials: map `AWS_ACCESS_KEY_ID` to the credential's full token id.

`fetchEnv` / `parseEnv` previously injected the credential's short token id (`token_id_short`, e.g. `805e248a8e54`) as `AWS_ACCESS_KEY_ID`. The storage gateway only accepts the full token id (`token_id`, e.g. `nak_live_805e248a8e54…`), so every S3 request failed with `InvalidAccessKeyId`. `env.storage.accessKeyId` (and `AWS_ACCESS_KEY_ID`) now carries the full token id, making the standard object-storage path usable.
