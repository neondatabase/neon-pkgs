---
"neon": patch
---

`neon psql` (and `--psql` on `connection-string`, `projects create`, and `branches create`) starts psql without first waiting for analytics to upload; the upload finishes while psql runs. The launch line now names the target, for example `Neon connection: neondb as neondb_owner on ep-…; launching psql...`.
