---
"@neondatabase/config": minor
"@neondatabase/config-runtime": minor
---

Fix `config apply` failing with HTTP 405 when creating a function.

The Neon API has no standalone "create function" endpoint: the functions collection (`POST /projects/{p}/branches/{b}/functions`) only supports `GET`, and a function is created implicitly by its first deployment (`POST .../functions/{slug}/deployments`). Pushing a policy with a new function therefore tried a non-existent create call and failed with `HTTP 405`.

- `@neondatabase/config`: remove `createBranchFunction` from the `NeonApi` interface, the real adapter, and the fake. `deployBranchFunction` now creates the function on first deploy. The `deploy-function` plan step carries a `functionExists` flag (the separate `create-function` `PlanStep` is gone).
- `@neondatabase/config-runtime`: `pushConfig` emits a single `deploy-function` step per function and reports it as a `create` (first deploy) or `update` (re-deploy) based on `functionExists`, instead of a separate create + deploy.
