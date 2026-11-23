---
"neon": patch
---

`neon init --services` now pulls the declared services the branch already has, such as Neon Auth, instead of only Postgres. Without a `neon.ts`, the env pull that `neon link` and `neon checkout` run no longer writes Object Storage credentials or the Realtime secret unless the env file already has them, keeps an AI Gateway token you pulled before, and names what it left out with the `neon env pull` command that adds it.
