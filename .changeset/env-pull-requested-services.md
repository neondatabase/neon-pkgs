---
"neon": patch
---

`neon link` and `neon checkout` no longer overwrite `AWS_*` keys in your env file that belong to another storage provider, and keep an AI Gateway token you pulled with `neon env pull` instead of removing it. `neon init --services` now pulls the declared services the branch already has, such as Neon Auth, instead of only Postgres.
