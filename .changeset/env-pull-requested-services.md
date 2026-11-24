---
"neon": patch
---

`neon init --services` now pulls the declared services the branch already has, such as Neon Auth, instead of only Postgres. Without a `neon.ts`, the env pull that `neon link` and `neon checkout` run writes Object Storage, Realtime, and AI Gateway secrets only when the env file already has them, refreshes those for the target branch, and names what it left out with the `neon env pull` command that adds it.
