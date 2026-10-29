---
"neon": patch
---

`neon neon-auth oauth-provider add` and `update` now name the right flags when Neon rejects a shared OAuth app for `apple` or `microsoft`. `update` for `apple` rejects `--apple-key-id` without a new client secret before sending a request, `--oauth-client-secret-file` strips every trailing line ending, and the `--oauth-client-id` and `--oauth-client-secret` help no longer implies every provider has a shared app.
