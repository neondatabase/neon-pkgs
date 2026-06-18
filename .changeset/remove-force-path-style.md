---
"@neondatabase/env": minor
---

Remove the `NEON_STORAGE_FORCE_PATH_STYLE` env var and the `storage.forcePathStyle` field from `NeonStorageEnv`.

It was always `true` and has no AWS-standard env name, so the S3 SDKs never read it automatically — you already had to wire `forcePathStyle` into your `S3Client` by hand. Neon's storage gateway always requires path-style addressing, so set `forcePathStyle: true` directly on your client. `env pull` no longer writes the variable, and `parseEnv` / `toEntries` no longer read or emit it. The raw `NeonBranchStorageSnapshot.forcePathStyle` from `@neondatabase/config` (the `GET .../storage` response) is unchanged.
