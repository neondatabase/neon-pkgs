---
"neon": patch
---

`neon init` and `neon config init` with `--services object-storage` now scaffold a bucket named `uploads`, the name Neon's Object Storage guides use, instead of `assets`. Existing `neon.ts` files are not touched.
