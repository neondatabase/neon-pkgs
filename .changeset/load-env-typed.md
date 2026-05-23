---
"@neondatabase/platform": minor
---

`loadEnv` now returns a fixed, statically-typed, namespaced shape — no more `Record<string, string>`, no call-site or config-driven env-var renames:

```ts
interface NeonEnv {
  postgres: {
    databaseUrl: string;          // pooled (PgBouncer)
    databaseUrlUnpooled: string;  // direct
  };
}

const env = await loadEnv(config);
const db = drizzle(neon(env.postgres.databaseUrl), { schema });
```

The previous `databaseUrlKey` / `databaseUrlUnpooledKey` options on `LoadEnvOptions` are removed. The keys are lowercase camelCase and live under a `postgres` namespace so future namespaces (`vector`, `s3`, …) can be added without breaking the existing surface.

Together with the project/branch resolution chain (`options.projectId|branch` → `NEON_PROJECT_ID` / `NEON_BRANCH_ID` → `.neon/project.json` → `.neon`), this makes `loadEnv` a typed drop-in replacement for `.env` entries: run `neon-ts branch` / `neonctl link` once to pin the branch, then `import config from "./neon"; const env = await loadEnv(config)` everywhere else.
