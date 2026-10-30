---
"@neon/config": minor
"@neon/config-runtime": minor
---

Model the auth provider a live Data API was created with. `NeonDataApiSnapshot` carries `authProvider` (`neon_auth` / `external` / `none`) and the external wiring (`jwksUrl`, `providerName`, `jwtAudience`) when the API reports them. `pullConfig` emits `dataApi: { authProvider: "external", … }` for such a Data API (and for one with an unreported provider on a branch without Neon Auth) instead of a bare `true`, so a pulled policy no longer declares Neon Auth over a Data API that never used it.
