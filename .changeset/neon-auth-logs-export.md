---
"neon": minor
---

Add `neon neon-auth config logs-export get|enable|disable` to turn on export of Neon Auth events to Neon logs (beta). `get` reports whether export is on, or that the project can't use it yet (`{"available": false}` with `-o json|yaml`): during the beta it requires Managed Better Auth in a supported region. Enabling or disabling on a branch that isn't on Better Auth says so. Read the exported events with `neon logs query --source neon_auth`. A query covers at most the last 7 days.
