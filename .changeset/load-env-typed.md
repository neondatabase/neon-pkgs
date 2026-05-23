---
"@neondatabase/platform": minor
---

`loadEnv` is now statically typed from the config. Declare your env-var keys once in `neon.ts` via the new `config.env` block:

```ts
const config = defineConfig({
  project: { name: "my-app" },
  branches: { production: {} },
  env: {
    databaseUrl: "POSTGRES_URL",
    databaseUrlUnpooled: "POSTGRES_URL_NON_POOLING",
  },
});

const env = await loadEnv(config);
//    ^? { POSTGRES_URL: string; POSTGRES_URL_NON_POOLING: string }
```

`defineConfig` is declared with a `const` generic so the literal strings flow through to `loadEnv`'s `LoadEnvResult<typeof config>`. Missing `config.env` falls back to `{ DATABASE_URL: string; DATABASE_URL_UNPOOLED: string }`. The previous call-site overrides (`databaseUrlKey` / `databaseUrlUnpooledKey` on `LoadEnvOptions`) are removed — config-as-code is the point.
