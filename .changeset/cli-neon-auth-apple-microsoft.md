---
"neon": minor
---

`neon neon-auth oauth-provider add` and `update` now support the `microsoft` and `apple` providers. New flags: `--microsoft-tenant-id`, `--apple-team-id`, `--apple-key-id`, and `--oauth-client-secret-file` to read the client secret (such as the Apple `.p8` private key) from a file. Changing the Apple client secret requires `--apple-key-id`.
