---
"@neon/env": minor
"neon": patch
---

**Breaking (`@neon/env`): the `@neon/env/runtime` entry point is removed.** It held
`fetchEnvReusingSecrets`, which reads an env source and can mint and revoke branch credentials.
Its only consumers were Neon's own CLIs, and a library that revokes your credentials because you
imported it is one you cannot safely embed — so it is now internal shared source rather than a
published path. If you were importing it, use the `neon` CLI (`neon env pull`, `neon dev`), or
`fetchEnv` plus your own persistence.

Everything else is unchanged: `fetchEnv`, `parseEnv`, `toEntries` and `NEON_ENV_VAR_KEYS` stay on
`@neon/env` with the same signatures, and the `neon-env` binary is unaffected.
