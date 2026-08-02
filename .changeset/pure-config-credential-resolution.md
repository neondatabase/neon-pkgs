---
"@neon/config": minor
"@neon/config-runtime": minor
"@neon/env": minor
---

Require an explicit `apiKey` — these packages no longer read `NEON_API_KEY` or `~/.config/neonctl/credentials.json`

`@neon/config` is documented as the pure half of the config toolchain, and `@neon/env`'s root
export as "never reads `process.env` or a file", but `createNeonApiFromOptions` reached for an
ambient credential when none was passed. That made `inspect`, `plan`, `apply`, `pushConfig`,
`pullConfig` and `fetchEnv` authenticate as whoever last ran `neon auth`, with no way for an
embedder to opt out.

`createNeonApiFromOptions(operation, { apiKey, apiHost })` now requires `apiKey` and throws
`PLATFORM_MISSING_API_KEY` without one. It reads no environment variables and no files.
`apiHost` no longer falls back to `NEON_API_HOST`. `resolveApiKey` is removed from
`@neon/config/v1`.

**If you were relying on the fallback**, resolve the key where you already know your users'
conventions and pass it in:

```ts
import { apply } from "@neon/config-runtime/v1";

await apply(config, {
  projectId,
  branchId,
  apiKey: process.env.NEON_API_KEY, // your call, not the library's
});
```

The `neon` and `neon-env` CLIs are unaffected — both resolve the key themselves and always
passed it explicitly. `neon-env`'s `--api-key` still defaults to `NEON_API_KEY` and then the
Neon CLI's stored credentials, now via its own `resolveApiKey`.
