---
"@neondatabase/env": minor
---

Remove the `NEON_STORAGE_REGION` env var (the Neon-branded alias of `AWS_REGION`).

The region is already injected under the SDK-standard `AWS_REGION`, which the AWS S3 SDKs read automatically — the duplicate `NEON_STORAGE_REGION` alias was never read back by `parseEnv` and bought nothing. `env pull` no longer writes it and `toEntries` no longer emits it. `NeonStorageEnv.region` (mapped to `AWS_REGION`) is unchanged.
