---
"@neondatabase/config": minor
"@neondatabase/config-runtime": minor
"@neondatabase/env": minor
---

Add branch-scoped service credentials (Preview) and surface them in the resolved env.

- `@neondatabase/config`: the `NeonApi` adapter gains `createCredential` / `listCredentials` / `revokeCredential` (backed by the beta `POST|GET|DELETE /projects/{id}/branches/{id}/credentials` endpoints), plus the `CredentialScope` / `CredentialPrincipalType` types, the `NeonCredentialSecret` / `NeonCredentialMeta` / `CreateCredentialInput` shapes, and pure `deriveCredentialScopes` / `credentialScopesSatisfied` helpers.
- `@neondatabase/env`: `fetchEnv` / `parseEnv` now expose a unified `credentials` namespace (`NEON_API_TOKEN`, `NEON_S3_ACCESS_KEY_ID`, `NEON_S3_SECRET_ACCESS_KEY`, `NEON_CREDENTIAL_ID`, `NEON_CREDENTIAL_SCOPES`) **only when the policy enables a credential-bearing Preview feature** — object storage (`preview.buckets`) or the AI Gateway (`preview.aiGateway`). `functions:invoke` rides along on that credential when functions are also declared, but functions never mint a credential on their own. `fetchEnv` reuses a credential already present in its env source (round-tripping the one-time `api_token` / `s3_secret_access_key`) and only re-mints when missing or when the policy needs a scope the persisted credential lacks. Policies without these Preview features never touch the credentials endpoint, so the Postgres / Auth / Data API path is unchanged.
- `@neondatabase/config-runtime`: `pullConfig` / `inspect` report secret-free issued-credential metadata under `preview.credentials` (degrading to none when the endpoint is unavailable).
