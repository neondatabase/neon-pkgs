---
"neonctl": patch
---

Fix AI Gateway "reduced model set" notices to consider only models with
`enabled: true` from `/v1/models`. The gateway lists the full catalog but marks
models the account cannot serve yet as `enabled: false`; previously the notice
checked every listed id and could miss accounts on a trimmed catalog.
