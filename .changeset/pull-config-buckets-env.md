---
"@neon/config-runtime": patch
"neonctl": patch
---

Pull a branch's object-storage vars without a `neon.ts`. `pullConfig` now mirrors the branch's buckets into the resolvable config, so `neon dev` / `neon env pull` inject the S3-compatible `AWS_*` credentials for a branch that has a bucket even when there is no local `neon.ts` policy — matching how Neon Auth / the Data API already resolve from live branch state. Functions and the AI Gateway remain excluded (neither has branch-level state that can be faithfully read back).
