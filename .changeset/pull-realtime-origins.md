---
"@neon/config-runtime": patch
---

`pullConfig` and `inspect` report a branch's Realtime allowed origins: `config.preview.realtime` is `{ allowedOrigins: [...] }` when the branch lists origins, and stays `true` when the list is empty.
