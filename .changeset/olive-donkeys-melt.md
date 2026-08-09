---
"@neon/env": minor
"neon": patch
---

**Breaking (`@neon/env`): the `@neon/env/runtime` entry point is removed.** It held
`fetchEnvReusingSecrets`, which reads an env source and can mint and revoke branch credentials.
Its only consumers were Neon's own CLIs, and a library that revokes your credentials because you
imported it is one you cannot safely embed — so it is now internal shared source rather than a
published path. If you were importing it, use the `neon` CLI (`neon env pull`, `neon dev`), which does this for you. Rolling your own is possible but the hard part is not storing the secret — it is **verifying** it: a persisted secret is only reusable if it still names a live credential on that branch, unrevoked, unexpired, and carrying every scope the policy needs. A presence check cannot tell a real secret from a `.env.example` placeholder, which is the bug 0.12.0 shipped a fix for. `credentialScopesSatisfied` and `deriveCredentialScopes` from `@neon/config/v1`, plus `listCredentials` / `createCredential` / `revokeCredential` on a `NeonApi`, are the pieces.

Everything else is unchanged: `fetchEnv`, `parseEnv`, `toEntries` and `NEON_ENV_VAR_KEYS` stay on
`@neon/env` with the same signatures, and the `neon-env` binary is unaffected.
