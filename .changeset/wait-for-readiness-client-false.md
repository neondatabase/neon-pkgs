---
"@neon/sdk": patch
---

`createNeonClient({ waitForReadiness: false })` now turns off readiness polling on `projects.create`, `projects.createAndConnect`, `branches.create`, and `branches.createAndConnect`. Those methods still default polling on when the client option is unset. Per-call `{ waitForReadiness }` still wins.
